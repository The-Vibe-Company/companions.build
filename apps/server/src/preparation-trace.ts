/** Opt-in preparation diagnostics. Never serialize operation values, errors, or endpoints. */
const phases=['box_create','box_get','box_resume','box_setup','box_endpoint','box_environment','box_services','box_service_desktop','box_service_agent','box_service_proxy','box_host','box_rediscovery_health','lifecycle_health','ready_checkpoint','admission_health','plugin_configuration','run_staging','admission_put'] as const;
const outcomes=['ok','error','ready','archived','not_ready','setup_pending','setup_failed','reused'] as const;
export type PreparationPhase=typeof phases[number];
type Outcome=typeof outcomes[number];
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function enabled(companionId:string,phase:PreparationPhase){return process.env.COMPANIONS_TRACE_PREPARATION==='1'&&uuid.test(companionId)&&phases.includes(phase);}
function emit(companionId:string,phase:PreparationPhase,startedMs:number,outcome:Outcome,runId?:string,durationMs=performance.now()-startedMs){
 try{
  console.info(JSON.stringify({event:'preparation_trace',companionId,phase,
   startedMs:Math.round(startedMs*1000)/1000,durationMs:Math.round(Math.max(0,durationMs)*1000)/1000,
   outcome:outcomes.includes(outcome)?outcome:'error',...(runId&&uuid.test(runId)?{runId}:{})}));
 }catch{/* Diagnostics cannot change execution or its error. */}
}
export function preparationMeasurement(companionId:string,phase:PreparationPhase,startedMs:number,durationMs:number,outcome:Outcome='ok'){
 if(enabled(companionId,phase)&&Number.isFinite(startedMs)&&Number.isFinite(durationMs)&&durationMs>=0)emit(companionId,phase,startedMs,outcome,undefined,durationMs);
}
export function preparationState(companionId:string,phase:PreparationPhase,outcome:Outcome){
 if(enabled(companionId,phase))emit(companionId,phase,performance.now(),outcome);
}
export async function tracePreparation<T>(companionId:string,phase:PreparationPhase,operation:()=>Promise<T>,resultOutcome?:(value:T)=>Outcome,runId?:string):Promise<T>{
 if(!enabled(companionId,phase))return operation();
 const startedMs=performance.now();
 try{const value=await operation();emit(companionId,phase,startedMs,resultOutcome?.(value)??'ok',runId);return value;}
 catch(error){emit(companionId,phase,startedMs,'error',runId);throw error;}
}
