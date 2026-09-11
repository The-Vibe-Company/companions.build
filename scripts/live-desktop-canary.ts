/** Paid, owned-Box acceptance: human takeover leaves headless execution and chat alive. */
import {createHash} from 'node:crypto';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {z} from 'zod';
import {config,decrypt} from '../apps/server/src/config';
import {db} from '../apps/server/src/store';
import {agentRequest} from '../apps/server/src/machines';
import {BoxClient} from '../packages/box/client';
import {waitForHeadlessStart} from './live-desktop-canary-wait';
const fail=(code:string):never=>{throw Error('DESKTOP_CANARY_'+code);};
let release:undefined|(()=>Promise<unknown>);
try {
 if(!config.boxKey||config.testMode)fail('LIVE_CONFIGURATION_REQUIRED');
 const source=await Bun.file(process.env.CANARY_STATE_FILE??'.local/box-canary-v1.json').json();
 const companionId=z.string().uuid().parse(source.companionId??source.parentId);
 const path=process.env.DESKTOP_CANARY_STATE_FILE??'.local/live-desktop-boundary-canary.json';
 const schema=z.object({companionId:z.string().uuid(),nonce:z.string().uuid(),messageId:z.string().uuid(),runId:z.string().uuid().optional(),takeoverRequested:z.boolean().optional(),passedAt:z.string().optional()});
 const state:z.infer<typeof schema>=await Bun.file(path).exists()?schema.parse(await Bun.file(path).json()):{companionId,nonce:crypto.randomUUID(),messageId:crypto.randomUUID()};
 if(state.companionId!==companionId)fail('JOURNAL_MISMATCH');
 const save=async()=>{mkdirSync(dirname(path),{recursive:true,mode:0o700});await Bun.write(path,JSON.stringify(state,null,2));chmodSync(path,0o600);};
 await save();
 const cookie=(await Bun.file('.local/session-cookie').text()).trim();
 const base=`http://127.0.0.1:${process.env.API_PORT??Number(process.env.WEB_PORT??4310)+1}/api/companions/${companionId}`;
 async function api(suffix='',body?:unknown){
  const response=await fetch(base+suffix,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
  if(!response.ok)fail('API_'+response.status);return response.json() as Promise<any>;
 }
 const detail=await api();
 if(detail.companion.provider!=='box'||detail.companion.retiredAt)fail('OWNED_LIVE_COMPANION_REQUIRED');
 if(detail.companion.desktopTaken&&!state.takeoverRequested)fail('HUMAN_ALREADY_CONTROLS_DESKTOP');
 const [row]=await db`SELECT box_id,endpoint_secret,agent_secret FROM companions WHERE id=${companionId} AND retired_at IS NULL`;
 if(!row?.box_id||row.box_id!==detail.companion.boxId||!row.endpoint_secret)fail('READY_BOX_REQUIRED');
 const endpoint=decrypt(row.endpoint_secret),token=decrypt(row.agent_secret);
 if((await agentRequest(endpoint,token,'/health')).desktopBoundaryVersion!==1)fail('DESKTOP_UPGRADE_REQUIRED');
 if(state.passedAt){console.log('DESKTOP_CANARY_ALREADY_PASSED');}
 else {
  if(state.takeoverRequested){await api('/desktop/release',{});state.takeoverRequested=false;await save();fail('OBSERVATION_INTERRUPTED');}
  if(detail.runs.some((r:any)=>!['succeeded','failed','interrupted','cancelled'].includes(r.status)&&r.id!==state.runId))fail('COMPANION_BUSY');
  const box=new BoxClient(config.boxKey!),stem='desktop-boundary-'+state.nonce;
  const workspace=`/var/lib/companions-agent/${companionId}/workspace`;
  // Paths contain validated UUIDs only; never pass model-generated commands to provider control.
  const read=async(suffix:'started'|'done')=>(await box.command(row.box_id,`sudo -n sh -c 'test ! -f ${workspace}/${stem}-${suffix} || cat ${workspace}/${stem}-${suffix}'`,30)).trim();
  async function until(label:string,check:()=>Promise<boolean>,timeout=180_000){const deadline=Date.now()+timeout;while(!await check()){if(Date.now()>deadline)fail(label+'_TIMEOUT');await Bun.sleep(500);}}
  const script=`import pathlib,time,urllib.request,hashlib; pathlib.Path('${stem}-started').write_text('started'); time.sleep(20); r=urllib.request.urlopen('https://example.com',timeout=15); assert r.status==200; pathlib.Path('${stem}-done').write_text(hashlib.sha256(b'${state.nonce}').hexdigest())`;
  const content=`Use bash to execute this Python code in the workspace, in the foreground, exactly once: ${script}. Do not background it. Reply HEADLESS_CONTINUED after success.`;
  if(!state.runId){state.runId=z.string().uuid().parse((await api('/messages',{clientMessageId:state.messageId,content})).runId);await save();}
  await waitForHeadlessStart({runId:state.runId,detail:()=>api(),started:async()=>await read('started')==='started'});
  if(await read('done'))fail('MISSED_TAKEOVER_WINDOW');
  state.takeoverRequested=true;await save();release=()=>api('/desktop/release',{});
  await api('/desktop/takeover',{});
  let generation:number|undefined;
  await until('GUI_QUIESCENT',async()=>{const current=await agentRequest(endpoint,token,'/desktop');if(current.taken&&current.confirmed){generation=current.generation;return true;}return false;},30_000);
  if(await read('done'))fail('MISSED_CONFIRMED_TAKEOVER_WINDOW');
  const expected=createHash('sha256').update(state.nonce).digest('hex');
  await until('HEADLESS_NETWORK_COMPLETED',async()=>await read('done')===expected,60_000);
  const held=await agentRequest(endpoint,token,'/desktop');
  if(!held.taken||!held.confirmed||held.generation!==generation)fail('TAKEOVER_LOST');
  await until('CHAT_SETTLED_WHILE_TAKEN',async()=>{const run=(await api()).runs.find((r:any)=>r.id===state.runId);if(['failed','interrupted','cancelled','needs_input'].includes(run?.status))fail('RUN_'+run.status.toUpperCase());return run?.status==='succeeded';},60_000);
  await release();release=undefined;state.takeoverRequested=false;await save();
  await until('GUI_RELEASED',async()=>{const current=await agentRequest(endpoint,token,'/desktop');return !current.taken&&current.confirmed&&current.generation>generation!;},30_000);
  state.passedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({status:'passed',guiConfirmed:true,headlessFileAndNetworkContinued:true,chatSettledDuringTakeover:true,explicitRelease:true}));
 }
} catch(error){
 if(release)await release().catch(()=>console.error('DESKTOP_CANARY_RELEASE_UNCONFIRMED'));
 console.error(error instanceof Error&&/^DESKTOP_CANARY_[A-Z_0-9]+$/.test(error.message)?error.message:'DESKTOP_CANARY_FAILED');process.exitCode=1;
} finally {await db.close();}
