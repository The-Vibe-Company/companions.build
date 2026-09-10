/** Only these codes may cross the daemon boundary. Never forward provider errors. */
export const PLUGIN_ERROR_CODES = ['PLUGIN_TIMEOUT','PLUGIN_CANCELLED','PLUGIN_CONNECTION_FAILED','PLUGIN_REMOTE_FAILED','PLUGIN_AUTH_FAILED','PLUGIN_NOT_FOUND','PLUGIN_RATE_LIMITED','PLUGIN_RESTARTED','PLUGIN_RESPONSE_TIMEOUT','PLUGIN_POLL_LIMIT','PLUGIN_RECONCILIATION_REQUIRED'] as const;
export type PluginErrorCode = typeof PLUGIN_ERROR_CODES[number];
export type PluginCall = {
  requestId:string;runId:string;toolCallId:string;connectionId:string;tool:string;attempt:number;
  phase:'prepare'|'connect'|'discover'|'call'|'cleanup';status:'running'|'succeeded'|'failed'|'interrupted';
  outcome:'not_sent'|'confirmed'|'unknown';code?:PluginErrorCode;startedAt:number;deadlineAt:number;updatedAt:number;
};
export class PluginFailure extends Error {
  constructor(readonly code:PluginErrorCode,readonly transient=false,readonly retryAfterMs=0){super(code);}
}
export function safePluginCode(error:unknown):PluginErrorCode|undefined {
  const code=error instanceof Error?error.message:undefined;
  return PLUGIN_ERROR_CODES.find(value=>value===code);
}
/** Bounds non-cooperative promises too; their later rejection is still observed. */
export function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const stop=()=>reject(signal.reason instanceof PluginFailure?signal.reason:new PluginFailure('PLUGIN_CANCELLED'));
    signal.addEventListener('abort',stop,{once:true});
    work.then(value=>{signal.removeEventListener('abort',stop);if(signal.aborted)stop();else resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});
    if(signal.aborted)stop();
  });
}
export function deadlineSignal(parent:AbortSignal,ms:number){
  const controller=new AbortController();
  const abort=()=>controller.abort(parent.reason);
  parent.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(new PluginFailure('PLUGIN_TIMEOUT',true)),Math.max(0,ms));
  if(parent.aborted)abort();
  return {signal:controller.signal,dispose(){clearTimeout(timer);parent.removeEventListener('abort',abort);}};
}
export async function boundedClose(close:()=>Promise<void>,ms=5000){
  const deadline=deadlineSignal(new AbortController().signal,ms);
  try{await abortable(Promise.resolve().then(close),deadline.signal);}catch{/* Cleanup never hides the operation outcome. */}
  finally{deadline.dispose();}
}
