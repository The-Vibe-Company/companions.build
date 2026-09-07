const failedTerminalStatuses=new Set(['failed','interrupted','cancelled']);

export async function waitForHeadlessStart(input:{
 runId:string;
 detail:()=>Promise<{runs?:Array<{id:string;status:string}>}>;
 started:()=>Promise<boolean>;
 sleep?:(milliseconds:number)=>Promise<unknown>;
 now?:()=>number;
 timeout?:number;
}){
 const now=input.now??Date.now,deadline=now()+(input.timeout??180_000),sleep=input.sleep??Bun.sleep;
 while(true){
  const run=(await input.detail()).runs?.find(item=>item.id===input.runId);
  if(run&&failedTerminalStatuses.has(run.status))throw Error(`DESKTOP_CANARY_RUN_${run.status.toUpperCase()}`);
  if(await input.started())return;
  if(run?.status==='succeeded')throw Error('DESKTOP_CANARY_HEADLESS_NOT_EXECUTED');
  if(now()>deadline)throw Error('DESKTOP_CANARY_HEADLESS_STARTED_TIMEOUT');
  await sleep(500);
 }
}
