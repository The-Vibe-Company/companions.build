import {config} from './config';
export const GREAT_MODEL_ID='gpt-5.6-luna';
export const FAST_MODEL_ID='deepseek-flash';
export const FAST_AGENT_MODEL_ID='gpt-5.6-sol';

/** Existing agents speak Responses through a stable SDK profile. The gateway alone
 * resolves the actual vendor/model; runs and usage retain that actual identity. */
export function agentModelId(provider:string,modelId:string){
 return provider==='deepseek'&&modelId===FAST_MODEL_ID?FAST_AGENT_MODEL_ID:modelId;
}
export function selectedProvider(modelId:string){
 if(modelId===FAST_MODEL_ID){
  if(!config.modelGatewayUrl||config.modelProvider!=='azure'||config.modelId!==GREAT_MODEL_ID)throw Error('MODEL_GATEWAY_REQUIRED');
  return 'deepseek';
 }
 return config.modelProvider;
}
export function fastModelAvailable(){
 return config.deepseekEnabled&&!!config.modelGatewayUrl&&config.modelProvider==='azure'&&config.modelId===GREAT_MODEL_ID;
}
