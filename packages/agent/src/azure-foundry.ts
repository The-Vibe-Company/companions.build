import {streamSimple as azureOpenAIResponses} from '@earendil-works/pi-ai/api/azure-openai-responses';
import type {ModelRuntime} from '@earendil-works/pi-coding-agent';

export function normalizeAzureFoundryBaseUrl(raw:string):string{
 let url:URL;try{url=new URL(raw.trim());}catch{throw Error('INVALID_AZURE_OPENAI_BASE_URL');}
 const host=url.hostname.toLowerCase();
 const azureHost=['.openai.azure.com','.cognitiveservices.azure.com','.services.ai.azure.com'].some(suffix=>host.endsWith(suffix)&&host.length>suffix.length);
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash||!azureHost)throw Error('INVALID_AZURE_OPENAI_BASE_URL');
 let path=url.pathname.replace(/\/+$/,'');
 if(path.endsWith('/responses'))path=path.slice(0,-'/responses'.length);
 if(!path.endsWith('/openai/v1'))throw Error('INVALID_AZURE_OPENAI_BASE_URL');
 url.pathname=path;return url.toString().replace(/\/+$/,'');
}

/** Azure's v1 project endpoint rejects the api-version query added by AzureOpenAI. */
export function configureAzureFoundry(runtime:ModelRuntime,rawBaseUrl:string,fetchImpl:typeof fetch=fetch):void{
 const baseUrl=normalizeAzureFoundryBaseUrl(rawBaseUrl);
 const base=new URL(baseUrl);
 const foundryFetch=(async(input,init)=>{
  const original=input instanceof Request?input.url:String(input),url=new URL(original);
  if(url.origin!==base.origin||url.pathname!==`${base.pathname}/responses`||[...url.searchParams].some(([key])=>key!=='api-version'))throw Error('AZURE_OPENAI_REQUEST_URL_INVALID');
  url.searchParams.delete('api-version');
  const request=input instanceof Request?new Request(url,input):url;
  return fetchImpl(request,init);
 }) as typeof fetch;
 runtime.registerProvider('azure-openai-responses',{
  baseUrl,api:'azure-openai-responses',
  streamSimple:(model,context,options)=>azureOpenAIResponses(model as any,context,{
   ...options,env:{...options?.env,AZURE_OPENAI_BASE_URL:baseUrl},fetch:foundryFetch,
   onPayload:async(payload:any,target:any)=>{
    const customized=await options?.onPayload?.(payload,target),body=customized??payload;
    // Foundry project endpoints require the protocol discriminator on message input
    // items, while the OpenAI and classic Azure endpoints accept it as implicit.
    if(!Array.isArray(body?.input))return body;
    return {...body,input:body.input.map((item:any)=>item&&typeof item==='object'&&item.role&&!item.type?{type:'message',...item}:item)};
   },
  }),
 });
}
