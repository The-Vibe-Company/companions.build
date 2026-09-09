import type { MachinePlugin } from './catalog';
import { getAppDefinitionByProvider } from './definitions';

/** Product-owned adapters are explicit capabilities, never arbitrary remote endpoints. */
const bridges={
  slack:{
    tools:[{name:'chat_post_message',description:'Send an explicitly authorized Slack message',inputSchema:{type:'object' as const,properties:{channel:{type:'string'},text:{type:'string'}},required:['channel','text']},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}}],
    async check(plugin:MachinePlugin,signal:AbortSignal) {
      const response=await fetch('https://slack.com/api/auth.test',{method:'POST',headers:plugin.headers,signal});
      const result=await response.json() as any;if(!response.ok||!result.ok)throw Error('PLUGIN_CONNECTION_FAILED');
    },
    async call(plugin:MachinePlugin,tool:string,args:Record<string,unknown>,signal?:AbortSignal) {
      if(tool!=='chat_post_message'||typeof args.channel!=='string'||typeof args.text!=='string')throw Error('PLUGIN_TOOL_NOT_ALLOWED');
      const response=await fetch('https://slack.com/api/chat.postMessage',{method:'POST',headers:{...plugin.headers,'content-type':'application/json'},body:JSON.stringify({channel:args.channel,text:args.text}),signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(30_000)])});
      const result=await response.json() as any;if(!response.ok||!result.ok)throw Error('SLACK_MESSAGE_FAILED');
      return {channel:result.channel,ts:result.ts};
    },
  },
};
export function appBridge(plugin:MachinePlugin) {
  const capability=getAppDefinitionByProvider(plugin.provider)?.capabilities?.bridge;
  return capability?bridges[capability]:undefined;
}
