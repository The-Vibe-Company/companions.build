import {createOpenAI} from '@ai-sdk/openai';
import {createAnthropic} from '@ai-sdk/anthropic';
import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import type {LanguageModel} from 'ai';
import {config} from './config';
import {agentModelId} from './model-selection';
import {mintDiscussionModelToken} from './model-gateway-token';

/** Provider secrets stay inside the API gateway. An executor token authorizes one live turn. */
export function discussionModel(run:any):LanguageModel {
 if(config.testMode)return scriptedDiscussionModel;
 return gatewayDiscussionModel(run);
}
export function gatewayDiscussionModel(run:any,transport:typeof fetch=fetch):LanguageModel {
 const base=(config.modelGatewayUrl??`http://127.0.0.1:${config.port}/api/model-gateway`).replace(/\/$/,'');
 const provider=run.model_provider,model=agentModelId(provider,run.model_id);
 const token=mintDiscussionModelToken(run.id,run.owner_id,run.leader_pid);
 const gatewayFetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const headers=new Headers(init?.headers);headers.set('x-companions-model-token',token);
  headers.set('x-companions-run-id',run.id);headers.set('x-companions-model-request-id',crypto.randomUUID());
  return transport(input,{...init,headers,redirect:'error'});
 };
 const options={apiKey:token,fetch:Object.assign(gatewayFetch,{preconnect:fetch.preconnect})};
 if(provider==='google')return createGoogleGenerativeAI({...options,baseURL:`${base}/google/google-generative-ai`})(model);
 if(provider==='anthropic')return createAnthropic({...options,baseURL:`${base}/anthropic/anthropic-messages/v1`})(model);
 if(['openai','azure','deepseek'].includes(provider))return createOpenAI({...options,baseURL:`${base}/${['azure','deepseek'].includes(provider)?'openai':provider}/openai-responses`}).responses(model);
 if(['openrouter','zai'].includes(provider))return createOpenAICompatible({...options,name:provider,baseURL:`${base}/${provider}/openai-completions`})(model);
 throw Error('DISCUSSION_MODEL_UNAVAILABLE');
}

/** Deterministic development provider; still runs the real AI SDK loop and persistence. */
export const scriptedDiscussionModel:LanguageModel={
 specificationVersion:'v4',provider:'companion-test',modelId:'discussion-scripted',supportedUrls:{},
 async doGenerate(){throw Error('Streaming only');},
 async doStream(options){
  const last=options.prompt.filter(m=>m.role==='user').at(-1);
  const text=last?.content.filter(p=>p.type==='text').map(p=>p.text).join(' ')??'';
  return {stream:new ReadableStream({start(controller){
   controller.enqueue({type:'stream-start',warnings:[]});
   controller.enqueue({type:'text-start',id:'answer'});
   controller.enqueue({type:'text-delta',id:'answer',delta:`Discussion test response: ${text.slice(0,500)}`});
   controller.enqueue({type:'text-end',id:'answer'});
   controller.enqueue({type:'finish',finishReason:{unified:'stop',raw:undefined},usage:{inputTokens:{total:0,noCache:0,cacheRead:0,cacheWrite:0},outputTokens:{total:0,text:0,reasoning:0}}});
   controller.close();
  }})};
 }
};
