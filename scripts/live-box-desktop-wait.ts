export type DesktopProvisioningObservation={firstObservedAt:string;lastObservedAt:string;durationMs:number;count:number};
/** Observe the provider-backed viewer without persisting its secret-bearing URL. */
export async function waitForDesktopUrl(input:{
 request:()=>Promise<Response>;
 state:{desktopProvisioning?:DesktopProvisioningObservation};
 save:()=>Promise<unknown>;
 now?:()=>number;
 sleep?:(milliseconds:number)=>Promise<unknown>;
}){
 const now=input.now??Date.now,sleep=input.sleep??Bun.sleep,deadline=now()+60_000;
 for(;;){
  let response:Response;try{response=await input.request();}catch{throw Error('DESKTOP_API_UNREACHABLE');}
  if(response.status!==200&&response.status!==202){await response.body?.cancel();throw Error(`DESKTOP_API_${response.status}`);}
  let value:any;try{value=await response.json();}catch{throw Error('DESKTOP_RESPONSE_INVALID');}
  if(response.status===202){
   if(value?.preparing!==true)throw Error('DESKTOP_RESPONSE_INVALID');
   const observed=now(),previous=input.state.desktopProvisioning,first=previous?Date.parse(previous.firstObservedAt):observed;
   if(!Number.isFinite(first)||first>observed||(previous&&(!Number.isSafeInteger(previous.count)||previous.count<1)))throw Error('DESKTOP_JOURNAL_INVALID');
   input.state.desktopProvisioning={firstObservedAt:new Date(first).toISOString(),lastObservedAt:new Date(observed).toISOString(),durationMs:observed-first,count:(previous?.count??0)+1};
   await input.save();
   if(now()>deadline)throw Error('DESKTOP_PROVISIONING_TIMEOUT');
   await sleep(500);continue;
  }
  try{
   if(typeof value?.url!=='string')throw Error();const url=new URL(value.url);
   if(url.protocol!=='https:'||url.username||url.password)throw Error();
  }catch{throw Error('DESKTOP_URL_INVALID');}
  return;
 }
}
