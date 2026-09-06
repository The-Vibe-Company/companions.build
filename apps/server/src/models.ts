import {config} from './config';
let catalog:Promise<Array<{id:string;name:string}>>|undefined;
export function availableModels(){
 if(config.testMode)return Promise.resolve([{id:'scripted',name:'Local test model'}]);
 return catalog??=(async()=>{
  const [{ModelRuntime},{InMemoryCredentialStore}]=await Promise.all([import('@earendil-works/pi-coding-agent'),import('@earendil-works/pi-ai')]);
  const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  return runtime.getModels(config.modelProvider).map(model=>({id:model.id,name:model.name}));
 })();
}
export async function validateModel(id:string){if(!(await availableModels()).some(model=>model.id===id))throw Error('MODEL_UNAVAILABLE');}
