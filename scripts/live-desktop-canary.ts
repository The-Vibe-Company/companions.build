/** Live, isolated canary: the existing canary Box only, never another user's resources. */
import {config} from '../apps/server/src/config';
import {BoxClient} from '../packages/box/client';
const state=await Bun.file(process.env.CANARY_STATE_FILE??'.local/box-canary-v1.json').json();
const cookie=(await Bun.file('.local/session-cookie').text()).trim();
const base=`http://127.0.0.1:${process.env.API_PORT??Number(process.env.WEB_PORT??4310)+1}/api/companions/${state.companionId}`;
const box=new BoxClient(config.boxKey!);const nonce=crypto.randomUUID().replaceAll('-','');
async function api(suffix='',body?:unknown){const response=await fetch(base+suffix,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!response.ok)throw Error('CANARY_API_'+response.status);return response.json() as any;}
async function until(label:string,check:()=>Promise<boolean>,timeout=180_000){const deadline=Date.now()+timeout;while(!await check()){if(Date.now()>deadline)throw Error(label+'_TIMEOUT');await Bun.sleep(500);}}
async function exists(name:string){return (await box.command(state.boxId,`test -f /home/user/.companions/workspace/${name} && printf YES || printf NO`)).trim()==='YES';}
const start=`pause-start-${nonce}`;const done=`pause-done-${nonce}`;
const {runId}=await api('/messages',{clientMessageId:crypto.randomUUID(),content:`Use bash to execute exactly: printf started > ${start}; sleep 25; printf done > ${done}. Keep bash in the foreground, do not background it. After it finishes reply exactly PAUSE_CANARY_OK.`});
let taken=false;
try{
 await until('tool_start',()=>exists(start));
 await api('/desktop/takeover',{});taken=true;
 await until('physical_pause',async()=>!!(await api()).companion.desktopPausedAt,30_000);
 console.log('Box confirms physical pause; waiting past the tool deadline.');
 await Bun.sleep(28_000);
 if(await exists(done))throw Error('TOOL_CONTINUED_WHILE_PAUSED');
 await api('/desktop/release',{});taken=false;
 await until('physical_release',async()=>!(await api()).companion.desktopPausedAt,30_000);
 await until('tool_resumed',()=>exists(done));
 await until('terminal',async()=>{const run=(await api()).runs.find((r:any)=>r.id===runId);return ['succeeded','failed','interrupted','cancelled'].includes(run?.status);});
 console.log(JSON.stringify({status:'passed',boxId:state.boxId,physicalPause:true,subprocessFrozen:true,resumed:true}));
}finally{if(taken)await api('/desktop/release',{});}
