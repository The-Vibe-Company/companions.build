/** Explicit operator migration of one existing Box. Stop the executor first; never replay a prompt. */
import {createHash} from 'node:crypto';
import {mkdirSync,renameSync,writeFileSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {z} from 'zod';
import {config} from '../apps/server/src/config';
import {db} from '../apps/server/src/store';
import {BoxClient} from '../packages/box/client';
import {userSystemctl} from '../packages/box/layout';

async function main(){
let lease:Awaited<ReturnType<typeof db.reserve>>|undefined;
try{
 const companionId=z.string().uuid().parse(process.argv[2]);
 if(!config.boxKey||config.testMode)throw Error('UPGRADE_LIVE_CONFIGURATION_REQUIRED');
 const cookie=(await Bun.file('.local/session-cookie').text()).trim();
 const response=await fetch(`http://127.0.0.1:${process.env.API_PORT??Number(process.env.WEB_PORT??4310)+1}/api/companions/${companionId}`,{headers:{cookie},signal:AbortSignal.timeout(10_000)});
 if(!response.ok)throw Error('UPGRADE_COMPANION_ACCESS_DENIED');
 const detail=await response.json() as any;
 if(detail.companion?.provider!=='box'||detail.companion.retiredAt)throw Error('UPGRADE_BOX_REQUIRED');
 lease=await db.reserve();
 const [lock]=await lease`SELECT pg_try_advisory_lock(721440139) AS owned`;
 if(!lock.owned)throw Error('UPGRADE_STOP_EXECUTOR_FIRST');
 async function fence(){
  const [held]=await lease!`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=0 AND objid=721440139 AND granted) AS owned`;
  if(!held?.owned)throw Error('UPGRADE_EXECUTOR_LEASE_LOST');
 }
 const [companion]=await lease`SELECT id,box_id FROM companions WHERE id=${companionId} AND retired_at IS NULL`;
 if(!companion?.box_id||companion.box_id!==detail.companion.boxId)throw Error('UPGRADE_BOX_IDENTITY_CHANGED');
 const active=await lease`SELECT id FROM runs WHERE companion_id=${companionId} AND status IN ('preparing','running','needs_input')`;
 if(active.length)throw Error('UPGRADE_ACTIVE_TASKS_MUST_FINISH');
 const box=new BoxClient(config.boxKey),machine=await box.get(companion.box_id);
 if(!['ready','idle','running'].includes(machine.state))throw Error('UPGRADE_PREPARE_EXISTING_BOX_FIRST');
 const journalPath=process.env.DESKTOP_UPGRADE_STATE_FILE??`.local/desktop-upgrade-${companionId}.json`;
 const journal=Bun.file(journalPath);
 const state=await journal.exists()?await journal.json():{version:1,companionId,boxId:companion.box_id,startedAt:new Date().toISOString()};
 if(state.companionId!==companionId||state.boxId!==companion.box_id)throw Error('UPGRADE_JOURNAL_IDENTITY_MISMATCH');
 function save(){mkdirSync(dirname(journalPath),{recursive:true,mode:0o700});writeFileSync(`${journalPath}.tmp`,JSON.stringify(state,null,2),{mode:0o600});renameSync(`${journalPath}.tmp`,journalPath);chmodSync(journalPath,0o600);}
 if(state.completedAt){console.log(JSON.stringify({status:'already-installed',companionId,boxId:companion.box_id}));return;}
 save();
 const tarPath=`.local/desktop-upgrade-${companionId}.tar.gz`;
 if(!state.digest){
 const tar=Bun.spawn(['tar','-czf',tarPath,'-C','dist/agent','.'],{stdout:'ignore',stderr:'ignore'});
 if(await tar.exited)throw Error('UPGRADE_BUILD_DISTRIBUTION_FIRST');
 }
 const archive=Buffer.from(await Bun.file(tarPath).arrayBuffer()),digest=createHash('sha256').update(archive).digest('hex');
 if(state.digest&&state.digest!==digest)throw Error('UPGRADE_DISTRIBUTION_CHANGED');
 state.digest=digest;save();
 async function command(value:string){await fence();return box.command(companion.box_id,value);}
 const staging=`/tmp/companions-desktop-upgrade-${digest.slice(0,20)}`;
 await command(`mkdir -p ${staging}`);
 for(let offset=0,index=0;offset<archive.length;offset+=3*1024*1024,index++){await fence();await box.writeFile(companion.box_id,`${staging}/part-${String(index).padStart(5,'0')}`,archive.subarray(offset,offset+3*1024*1024).toString('base64'),'base64');}
 await command(`cat ${staging}/part-* > ${staging}/bundle.tar.gz && printf '%s  %s\n' ${digest} ${staging}/bundle.tar.gz | sha256sum -c - >/dev/null && mkdir -p ${staging}/distribution && tar -xzf ${staging}/bundle.tar.gz -C ${staging}/distribution`);
 // Existing user/runtime state remains at its exact path. Only owned service invocations stop.
 await command(`${userSystemctl('thaw companions-agent.service')} 2>/dev/null || true`);
 await command(`${userSystemctl('disable --now companions-agent.service')} 2>/dev/null || true`);
 await command('sudo -n systemctl stop companions-agent-proxy.socket companions-agent-proxy.service companions-agent.service companions-desktop.service 2>/dev/null || true');
 await command(`case "$(${userSystemctl('is-active companions-agent.service')} 2>/dev/null || true)" in inactive|failed|unknown) ;; *) exit 1;; esac; for unit in companions-agent-proxy.socket companions-agent-proxy.service companions-agent.service companions-desktop.service; do case "$(sudo -n systemctl is-active "$unit" 2>/dev/null || true)" in inactive|failed|unknown) ;; *) exit 1;; esac; done`);
 await command(`sudo -n mkdir -p /opt/companions && sudo -n cp -a ${staging}/distribution/. /opt/companions/ && sudo -n chown -R root:root /opt/companions && sudo -n sh /opt/companions/install-desktop.sh`);
 await command(`sudo -n python3 /opt/companions/configure-desktop.py ${companionId} && sudo -n systemctl start companions-agent.service companions-agent-proxy.socket`);
 await fence();
 await lease`UPDATE companions SET config_digest=null,endpoint_secret=null,prepare_requested=true,desktop_paused_at=null,
   desktop_boundary_version=0,desktop_observed_generation=null,desktop_broker_boot_id=null,desktop_checked_at=null,error=null WHERE id=${companionId} AND box_id=${companion.box_id}`;
 state.completedAt=new Date().toISOString();save();
 console.log(JSON.stringify({status:'installed',companionId,boxId:companion.box_id,statePathPreserved:true,next:'Restart the executor to reconcile readiness and the retained desktop intent.'}));
}catch(error){console.error(error instanceof Error&&/^UPGRADE_[A-Z_]+$/.test(error.message)?error.message:'UPGRADE_FAILED');process.exitCode=1;}
finally{if(lease){try{await lease`SELECT pg_advisory_unlock(721440139)`;}finally{lease.release();}}await db.close();}

}
await main();
