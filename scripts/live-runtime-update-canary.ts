/** Owns one disposable test Box; upgrades it in place and archives its disk in finally. */
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {config,encrypt} from '../apps/server/src/config';
import {BoxClient,BoxError} from '../packages/box/client';
import {fetchAgent} from '../packages/box/transport';
import {runtimeUpdateMachine} from '../apps/server/src/runtime-updates';

const directory=process.env.RUNTIME_UPDATE_CANARY_DIR??'.local/runtime-update-canary';mkdirSync(directory,{recursive:true,mode:0o700});
const journalFile=`${directory}/journal.json`;
const state:any=await Bun.file(journalFile).exists()?await Bun.file(journalFile).json():{id:crypto.randomUUID(),creationId:crypto.randomUUID(),runId:crypto.randomUUID(),startedAt:new Date().toISOString()};
function save(){writeFileSync(journalFile+'.tmp',JSON.stringify(state,null,2),{mode:0o600});renameSync(journalFile+'.tmp',journalFile);}
function fail(code:string):never{throw Error(code);}
async function wait(check:()=>Promise<boolean>,label:string,ms=180_000){const until=Date.now()+ms;while(!await check()){if(Date.now()>until)fail(label);await Bun.sleep(1000);}}
if(!config.boxKey||!config.boxTemplate)fail('CANARY_BOX_CONFIGURATION_REQUIRED');
if(state.archivedAt)fail('CANARY_ALREADY_ARCHIVED_USE_NEW_JOURNAL');
const box=new BoxClient(config.boxKey),machine=runtimeUpdateMachine();if(!machine)fail('CANARY_RELEASE_REQUIRED');
let cleanupError=false;
try{
 save();if(!state.boxId){state.boxId=(await box.create(state.creationId,config.boxTemplate)).id;save();}
 await wait(async()=>['running','idle','ready'].includes((await box.get(state.boxId)).state),'CANARY_BOX_READY_TIMEOUT');
 const id=state.boxId;
 if(!state.preparedAt){
  await box.command(id,'sudo -n systemctl stop companions-agent-proxy.socket companions-agent-proxy.service companions-agent.service');
  const env=`AGENT_TOKEN=canary-${state.id}\nAGENT_TEST_MODE=1\nAGENT_STATE_DIR=/home/user/.companions\nPORT=8787\nMODEL_PROVIDER=companion-test\nMODEL_ID=scripted\n`;
  await box.writeFile(id,'/home/user/.companions.env',env);
  await box.command(id,`chmod 600 /home/user/.companions.env && sudo -n python3 /opt/companions/configure-desktop.py ${state.id} && sudo -n systemctl start companions-agent.service companions-agent-proxy.socket`);
  state.preparedAt=new Date().toISOString();save();
 }
 state.step='host';save();
 let endpoint:string|undefined;
 await wait(async()=>{try{endpoint=await box.host(id,8787);return true;}catch{return false;}},'CANARY_HOST_TIMEOUT');
 const token=`canary-${state.id}`;
 async function api(path:string,method='GET',body?:unknown){const r=await fetchAgent(endpoint!,token,path,method,body);if(!r.ok)fail('CANARY_AGENT_REQUEST_FAILED');return r.json() as Promise<any>;}
 await wait(async()=>{try{return (await api('/health')).ready;}catch{return false;}},'CANARY_AGENT_READY_TIMEOUT');
 state.step='fixtures';save();
 const companion={id:state.id,box_id:id,endpoint_secret:encrypt(endpoint!),agent_secret:encrypt(token)};
 if(!state.fixtureAt){
  const fixture=await box.command(id,`sudo -n python3 -c 'from pathlib import Path; import hashlib,json,os,pwd; root=Path("/var/lib/companions-agent/${state.id}"); p=root/"workspace"/"update-preservation.txt"; p.write_text("keep-user-data"); u=pwd.getpwnam("companions-agent"); os.chown(p,u.pw_uid,u.pw_gid); app=Path("/usr/local/bin/runtime-canary-user-app"); app.write_text("#!/bin/sh\\nprintf keep-user-app\\n"); app.chmod(0o755); print(json.dumps({"file":hashlib.sha256(p.read_bytes()).hexdigest(),"app":hashlib.sha256(app.read_bytes()).hexdigest()}))'`);
  state.fixture=JSON.parse(fixture);state.fixtureAt=new Date().toISOString();save();
 }
 if(!state.historyAt){
  state.requestIntentAt??=new Date().toISOString();save();
  // Stable request ID: an interrupted harness observes this same request on rerun.
  const previous=await fetchAgent(endpoint!,token,`/runs/${state.runId}`);
  if(previous.status===404)await api(`/runs/${state.runId}`,'PUT',{content:'Keep this canary history.',instructions:''});
  else if(!previous.ok)fail('CANARY_HISTORY_UNCONFIRMED');
  await wait(async()=>{const r=await api(`/runs/${state.runId}`);if(['failed','interrupted','cancelled'].includes(r.status))fail('CANARY_HISTORY_FAILED');return r.status==='succeeded';},'CANARY_HISTORY_TIMEOUT');
  state.historyAt=new Date().toISOString();save();
 }
 state.updateId??=crypto.randomUUID();save();
 state.step='update';save();
 const job={id:state.updateId,box_id:id,target_version:machine.release.id,manifest:machine.release,installer_sha256:machine.installerHash};
 const guard=async()=>{if(id!==state.boxId)fail('CANARY_IDENTITY_CHANGED');};
 if(!state.applyIntentAt){
  const staged=await machine.stage(job,guard);
  if(staged.state!=='staged'){
   // Test-owned machine only: capture source line numbers, never process environments or payloads.
   const probeCode=`import runpy,traceback,json
from pathlib import Path
m=runpy.run_path("/tmp/companions-runtime-${state.updateId}/update-runtime.py")
system=m["LinuxSystem"]()
processes=system.service_processes()
pid=next(pid for pid,command in processes if command.startswith("/opt/companions/companion-agent"))
root=Path(f"/proc/{pid}/root")
try:
 system.preflight()
except Exception as e:
 print(json.dumps({"runEntries":[p.name for p in (root/"run").iterdir()],"hostResolver":str(system.host_resolver_target()),"preflightLines":[f.lineno for f in traceback.extract_tb(e.__traceback__) if f.filename.endswith("update-runtime.py")]}))`;
   const encoded=Buffer.from(probeCode).toString('base64');
   const diagnostic=await box.command(id,`sudo -n python3 -c 'import base64;exec(base64.b64decode("${encoded}"))'`).catch(()=>'{"diagnostic":"unavailable"}');
   state.diagnostic=JSON.parse(diagnostic);save();
   fail(`CANARY_STAGE_${staged.code??'FAILED'}`);
  }
  const health=await api('/health');if(health.maintenanceSupported)await machine.drain(companion);
  state.applyIntentAt=new Date().toISOString();save();
  try{state.result=await machine.apply(job,guard);save();}catch{state.result={state:'unknown'};save();}
 }
 await wait(async()=>{
  const result=await machine.inspect(job,'status',guard);state.result={state:result.state,code:result.code};save();
  if(result.state==='succeeded')return true;
  if(['deferred','rolled_back','failed','not_started'].includes(result.state))fail(`CANARY_UPDATE_${result.code??result.state.toUpperCase()}`);
  await machine.inspect(job,'reconcile',guard);return false;
 },'CANARY_UPDATE_TIMEOUT');
 const health=await api('/health');if(health.runtimeVersion!==machine.release.id)fail('CANARY_VERSION_MISMATCH');
 await machine.undrain(companion);
 const retained=await box.command(id,`sudo -n python3 -c 'from pathlib import Path; import hashlib,json; p=Path("/var/lib/companions-agent/${state.id}/workspace/update-preservation.txt"); a=Path("/usr/local/bin/runtime-canary-user-app"); print(json.dumps({"file":hashlib.sha256(p.read_bytes()).hexdigest(),"app":hashlib.sha256(a.read_bytes()).hexdigest()}))'`);
 if(JSON.stringify(JSON.parse(retained))!==JSON.stringify(state.fixture))fail('CANARY_USER_DATA_CHANGED');
 if((await api(`/runs/${state.runId}`)).status!=='succeeded')fail('CANARY_HISTORY_CHANGED');
 if(await box.command(id,'/usr/local/bin/runtime-canary-user-app')!=='keep-user-app')fail('CANARY_USER_APP_CHANGED');
 state.passedAt=new Date().toISOString();save();console.log(JSON.stringify({status:'passed',sameBox:true,userFilePreserved:true,userAppPreserved:true,historyPreserved:true,runtimeVersion:health.runtimeVersion}));
}catch(error){state.error=error instanceof BoxError?`CANARY_${error.code.toUpperCase()}`:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'CANARY_FAILED';save();console.error(state.error);process.exitCode=1;}
finally{
 if(state.boxId){
  try{
   await box.stop(state.boxId);
   await wait(async()=>(await box.get(state.boxId)).state==='archived','CANARY_ARCHIVE_TIMEOUT',10*60_000);
   state.archivedAt=new Date().toISOString();save();console.log(JSON.stringify({cleanup:'archived',diskPreserved:true}));
  }catch{cleanupError=true;state.cleanupError='CANARY_ARCHIVE_UNCONFIRMED';save();}
 }
 if(cleanupError){console.error('CANARY_ARCHIVE_UNCONFIRMED');process.exitCode=1;}
}
