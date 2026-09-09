import {config} from './config';
let catalog:Promise<Array<{id:string;name:string}>>|undefined,catalogKey:string|undefined;
export function availableModels(){
 if(config.testMode)return Promise.resolve([{id:'scripted',name:'Local test model'}]);
 const key=`${config.modelProvider}/${config.modelId}`;
 if(catalogKey!==key){catalog=undefined;catalogKey=key;}
 return catalog??=(async()=>{
  const [{ModelRuntime},{InMemoryCredentialStore}]=await Promise.all([import('@earendil-works/pi-coding-agent'),import('@earendil-works/pi-ai')]);
  const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  const provider=config.modelProvider==='azure'?'azure-openai-responses':config.modelProvider;
  return runtime.getModels(provider).filter(model=>config.modelProvider!=='azure'||model.id===config.modelId).map(model=>({id:model.id,name:model.name}));
 })();
}
export async function validateModel(id:string){if(!(await availableModels()).some(model=>model.id===id))throw Error('MODEL_UNAVAILABLE');}
