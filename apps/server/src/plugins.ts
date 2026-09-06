import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { db } from './store';
import { encrypt, decrypt } from './config';
import { pluginCatalog, type MachinePlugin } from '../../../packages/plugins/catalog';
import { beginCompanionPluginOAuth, completeCompanionPluginOAuth, refreshCompanionPluginOAuth, CompanionPluginOAuthError, CompanionPluginOAuthRevokedError, COMPANION_GMAIL_MCP_ALLOWED_TOOLS, type CompanionPluginStoredOAuthCredential } from '../../../packages/plugins/oauth';

const uuid = z.string().uuid();
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const callback = () => new URL('/api/plugins/callback', process.env.APP_URL ?? 'http://127.0.0.1:4310').href;
const configuredOAuth:Partial<Record<string,readonly string[]>>={
 'io.github.github/github-mcp-server':['COMPANION_MCP_GITHUB_CLIENT_ID','COMPANION_MCP_GITHUB_CLIENT_SECRET'],
 'com.slack/mcp':['COMPANION_MCP_SLACK_CLIENT_ID','COMPANION_MCP_SLACK_CLIENT_SECRET'],
 'com.google.workspace/gmail':['COMPANION_MCP_GMAIL_CLIENT_ID','COMPANION_MCP_GMAIL_CLIENT_SECRET'],
};
export function pluginConnectionAvailable(serverId:string,env:NodeJS.ProcessEnv=process.env) {return (configuredOAuth[serverId]??[]).every(key=>!!env[key]?.trim());}
export const listPluginCatalog=()=>pluginCatalog.map(provider=>({...provider,available:pluginConnectionAvailable(provider.id)}));
export async function migratePlugins(sql:any) { await sql.unsafe(await Bun.file(new URL('./plugins.sql',import.meta.url)).text()); }
export class PluginError extends Error {}
const publicColumns = db`id,provider,label,server_id AS "serverId",health_status AS "healthStatus",health_code AS "healthCode",health_checked_at AS "checkedAt",created_at AS "createdAt"`;
export async function listPluginAccounts(ownerId:string) { return db`SELECT ${publicColumns} FROM plugin_accounts WHERE owner_id=${ownerId} ORDER BY created_at`; }
export async function startPluginConnection(ownerId:string, serverId:string, label:string,env:NodeJS.ProcessEnv=process.env) {
  const provider = pluginCatalog.find(p => p.id === serverId);
  if(!provider) throw new PluginError('Choose an available plugin.');
  if(!pluginConnectionAvailable(serverId,env))throw new PluginError(`${provider.name} connection is unavailable in this deployment.`);
  const state=randomBytes(32).toString('base64url');
  const {authorizationUrl,flow}=await beginCompanionPluginOAuth({serverName:serverId,state,redirectUri:callback(),env});
  await db`INSERT INTO plugin_oauth_flows (state_hash,owner_id,label,flow_secret,expires_at) VALUES (${hash(state)},${ownerId},${label.slice(0,80)||provider.name},${encrypt(JSON.stringify(flow))},now()+interval '10 minutes')`;
  return {url:authorizationUrl};
}
async function consumePluginFlow(ownerId:string,state:string) {
  const [row]=await db`UPDATE plugin_oauth_flows SET consumed_at=now() WHERE state_hash=${hash(state)} AND owner_id=${ownerId} AND consumed_at IS NULL AND expires_at>now() RETURNING *`;
  if(!row) throw new PluginError('This connection link expired. Connect again.');
  return row;
}
export async function completePluginConnection(ownerId:string,state:string,code:string) {
  const row=await consumePluginFlow(ownerId,state);
  const flow=JSON.parse(decrypt(row.flow_secret));
  const credential=await completeCompanionPluginOAuth({flow,code,redirectUri:callback()});
  const id=crypto.randomUUID();
  await db`INSERT INTO plugin_accounts (id,owner_id,provider,label,server_id,credential_secret) VALUES (${id},${ownerId},${flow.provider},${row.label},${flow.serverName},${encrypt(JSON.stringify(credential))})`;
  return {id};
}
export async function cancelPluginConnection(ownerId:string,state:string) {await consumePluginFlow(ownerId,state);}
const customSchema=z.object({label:z.string().trim().min(1).max(80),transport:z.enum(['http','stdio']).default('http'),url:z.string().url().optional(),command:z.string().min(1).max(500).optional(),args:z.array(z.string().max(2000)).max(50).default([]),headers:z.record(z.string(),z.string().max(8000)).default({}),env:z.record(z.string(),z.string().max(8000)).default({})});
const storedOAuthSchema=z.object({
  kind:z.literal('oauth'),version:z.literal(1),serverName:z.string(),accessToken:z.string().min(1).refine(value=>!/[\r\n\0]/.test(value)),
  refreshToken:z.string().nullable(),accessExpiresAt:z.string().datetime().nullable(),scope:z.string().nullable(),tokenType:z.literal('Bearer'),
  tokenEndpoint:z.string().url(),resource:z.string(),client:z.object({clientId:z.string().min(1),clientSecret:z.string().nullable(),tokenEndpointAuthMethod:z.enum(['none','client_secret_post','client_secret_basic'])}),
}).passthrough();
export async function addCustomPlugin(ownerId:string,input:unknown) {
  const value=customSchema.parse(input);
  if(value.transport==='http') {
    if(!value.url) throw new PluginError('An MCP URL is required.');
    const url=new URL(value.url);
    if(url.protocol!=='https:' || url.username || url.password) throw new PluginError('Use an HTTPS MCP URL without embedded credentials.');
  } else if(!value.command) throw new PluginError('An MCP command is required.');
  const id=crypto.randomUUID();
  // MCP processes and custom URLs are used only inside the member's agent computer.
  await db`INSERT INTO plugin_accounts (id,owner_id,provider,label,credential_secret) VALUES (${id},${ownerId},'custom',${value.label},${encrypt(JSON.stringify({kind:'custom',...value}))})`;
  return {id};
}
export async function attachPlugin(ownerId:string,companionId:string,accountId:string,enabled:boolean) {
  uuid.parse(companionId);uuid.parse(accountId);
  const [owned]=await db`SELECT c.id FROM companions c JOIN plugin_accounts p ON p.owner_id=c.owner_id WHERE c.id=${companionId} AND p.id=${accountId} AND c.owner_id=${ownerId}`;
  if(!owned) throw new PluginError('Companion or connection not found.');
  if(enabled) await db`INSERT INTO companion_plugins VALUES (${companionId},${accountId}) ON CONFLICT DO NOTHING`;
  else await db`DELETE FROM companion_plugins WHERE companion_id=${companionId} AND account_id=${accountId}`;
}
export async function disconnectPlugin(ownerId:string,id:string) { uuid.parse(id); await db`DELETE FROM plugin_accounts WHERE id=${id} AND owner_id=${ownerId}`; }
export async function selectedPlugins(ownerId:string,companionId:string) {
  return db`SELECT p.id,p.provider,p.label FROM companion_plugins cp JOIN plugin_accounts p ON p.id=cp.account_id JOIN companions c ON c.id=cp.companion_id WHERE c.id=${companionId} AND c.owner_id=${ownerId} AND p.owner_id=${ownerId}`;
}

export type PluginHealthCode='authorization_required'|'connection_failed'|'configuration_invalid'|'agent_check_required';
export type PluginHealthResult={id:string;healthStatus:'ok'|'error'|'requires_agent';healthCode:PluginHealthCode|null;checkedAt:Date};
export interface PluginHealthDependencies {
  check?:(plugin:MachinePlugin,signal:AbortSignal)=>Promise<void>;
  refresh?:(input:{credential:CompanionPluginStoredOAuthCredential;signal?:AbortSignal})=>Promise<CompanionPluginStoredOAuthCredential>;
  now?:()=>Date;
}

async function discoverPlugin(plugin:MachinePlugin,signal:AbortSignal) {
  if(plugin.transport==='slack') {
    const result=await fetch('https://slack.com/api/auth.test',{method:'POST',headers:plugin.headers,signal});
    const body=await result.json().catch(()=>null) as {ok?:boolean}|null;
    if(!result.ok||body?.ok!==true)throw Error('PLUGIN_CONNECTION_FAILED');
    return;
  }
  if(plugin.transport!=='http'||!plugin.url)throw Error('PLUGIN_CONFIGURATION_INVALID');
  const client=new Client({name:'companions.build-health',version:'0.2.0'});
  const transport=new StreamableHTTPClientTransport(new URL(plugin.url),{requestInit:{headers:plugin.headers}});
  try {
    await client.connect(transport,{timeout:10_000,signal});
    await client.listTools(undefined,{timeout:10_000,signal});
  } finally {await client.close().catch(()=>undefined);}
}

function healthProjection(row:any):PluginHealthResult {
  return{id:row.id,healthStatus:row.health_status,healthCode:row.health_code,checkedAt:new Date(row.health_checked_at)};
}

/** Owner-triggered, read-only connection discovery. Custom MCP definitions stay agent-computer-only. */
export async function checkPluginAccount(ownerId:string,accountId:string,deps:PluginHealthDependencies={}):Promise<PluginHealthResult|null> {
  uuid.parse(accountId);
  const now=deps.now?.()??new Date();
  let plugin:MachinePlugin|null=null;
  let early:PluginHealthResult['healthStatus']|null=null;
  let earlyCode:PluginHealthCode|null=null;
  try {
    const prepared=await db.begin(async tx=>{
      const [row]=await tx`SELECT * FROM plugin_accounts WHERE id=${accountId} AND owner_id=${ownerId} FOR UPDATE`;
      if(!row)return null;
      const rawCredential=JSON.parse(decrypt(row.credential_secret));
      if(rawCredential.kind==='custom'){customSchema.parse(rawCredential);return{custom:true as const};}
      let credential=storedOAuthSchema.parse(rawCredential) as CompanionPluginStoredOAuthCredential;
      if(credential.serverName!==row.server_id)throw Error('PLUGIN_CONFIGURATION_INVALID');
      if(credential.accessExpiresAt&&Date.parse(credential.accessExpiresAt)<Date.now()+60_000){
        credential=await (deps.refresh??refreshCompanionPluginOAuth)({credential,signal:AbortSignal.timeout(10_000)});
        await tx`UPDATE plugin_accounts SET credential_secret=${encrypt(JSON.stringify(credential))} WHERE id=${accountId} AND owner_id=${ownerId}`;
      }
      const provider=pluginCatalog.find(item=>item.id===row.server_id);
      if(!provider)throw Error('PLUGIN_CONFIGURATION_INVALID');
      return{custom:false as const,plugin:{id:row.id,name:row.label,provider:provider.provider,transport:provider.transport as 'http'|'slack',url:provider.url,headers:{Authorization:`Bearer ${credential.accessToken}`},...(provider.provider==='gmail'?{allowedTools:[...COMPANION_GMAIL_MCP_ALLOWED_TOOLS]}:{})} satisfies MachinePlugin};
    });
    if(!prepared)return null;
    if(prepared.custom){early='requires_agent';earlyCode='agent_check_required';}
    else plugin=prepared.plugin;
  } catch(error) {
    early='error';
    earlyCode=error instanceof CompanionPluginOAuthRevokedError||error instanceof CompanionPluginOAuthError&&error.code==='oauth_refresh_failed'?'authorization_required':'configuration_invalid';
  }
  if(plugin&&!early){
    try{await (deps.check??discoverPlugin)(plugin,AbortSignal.timeout(10_000));}
    catch{early='error';earlyCode='connection_failed';}
  }
  const healthStatus=early??'ok',healthCode=earlyCode;
  const [saved]=await db`UPDATE plugin_accounts SET health_status=${healthStatus},health_code=${healthCode},health_checked_at=${now} WHERE id=${accountId} AND owner_id=${ownerId} RETURNING id,health_status,health_code,health_checked_at`;
  return saved?healthProjection(saved):null;
}
/** Executor-only credential projection, never a browser response. Refresh is serialized by row lock. */
export async function machinePlugins(companionId:string):Promise<MachinePlugin[]> {
  return db.begin(async tx => {
    const rows=await tx`SELECT p.* FROM companion_plugins cp JOIN plugin_accounts p ON p.id=cp.account_id JOIN companions c ON c.id=cp.companion_id WHERE c.id=${companionId} AND c.owner_id=p.owner_id FOR UPDATE OF p`;
    const result:MachinePlugin[]=[];
    for(const row of rows) {
      let credential=JSON.parse(decrypt(row.credential_secret));
      if(credential.kind==='custom') { result.push({id:row.id,name:row.label,provider:'custom',...credential});continue; }
      if(credential.accessExpiresAt && Date.parse(credential.accessExpiresAt)<Date.now()+60_000) {
        credential=await refreshCompanionPluginOAuth({credential:credential as CompanionPluginStoredOAuthCredential});
        await tx`UPDATE plugin_accounts SET credential_secret=${encrypt(JSON.stringify(credential))} WHERE id=${row.id}`;
      }
      const provider=pluginCatalog.find(p=>p.id===row.server_id);
      if(!provider) throw new PluginError('Connection requires an update.');
      result.push({id:row.id,name:row.label,provider:provider.provider,transport:provider.transport as 'http'|'slack',url:provider.url,headers:{Authorization:`Bearer ${credential.accessToken}`},...(provider.provider==='gmail'?{allowedTools:[...COMPANION_GMAIL_MCP_ALLOWED_TOOLS]}:{})});
    }
    return result;
  });
}
const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
type PluginCallbackStatus='connected'|'cancelled'|'error';
export function pluginCallbackLocation(status:PluginCallbackStatus) {
  const target=new URL('/connections',process.env.APP_URL??'http://127.0.0.1:4310');target.searchParams.set('connection',status);return target.href;
}
export async function handlePlugins(request:Request,ownerId:string):Promise<Response|null> {
  const url=new URL(request.url);const path=url.pathname;
  if(path==='/api/plugins' && request.method==='GET') return response({catalog:listPluginCatalog(),accounts:await listPluginAccounts(ownerId)});
  if(path==='/api/plugins/connect' && request.method==='POST') {const v=z.object({serverId:z.string(),label:z.string().max(80).default('')}).parse(await request.json());return response(await startPluginConnection(ownerId,v.serverId,v.label));}
  if(path==='/api/plugins/custom' && request.method==='POST') return response(await addCustomPlugin(ownerId,await request.json()),201);
  const check=path.match(/^\/api\/plugins\/accounts\/([a-f0-9-]+)\/check$/);
  if(check&&request.method==='POST') {const result=await checkPluginAccount(ownerId,check[1]);return result?response({account:result}):response({error:'Connection not found.'},404);}
  if(path==='/api/plugins/callback' && request.method==='GET') {
    let status:PluginCallbackStatus='error';
    try{
      const state=z.string().min(20).max(200).parse(url.searchParams.get('state'));
      const providerError=z.string().max(200).nullable().parse(url.searchParams.get('error'));
      if(providerError){await cancelPluginConnection(ownerId,state);status=providerError==='access_denied'?'cancelled':'error';}
      else{await completePluginConnection(ownerId,state,z.string().min(1).max(4000).parse(url.searchParams.get('code')));status='connected';}
    }catch{/* Return a stable browser result; provider details and credentials never enter the URL. */}
    return new Response(null,{status:303,headers:{location:pluginCallbackLocation(status),'cache-control':'no-store'}});
  }
  const account=path.match(/^\/api\/plugins\/([a-f0-9-]+)$/);
  if(account&&request.method==='DELETE') {await disconnectPlugin(ownerId,account[1]);return response({ok:true});}
  const match=path.match(/^\/api\/companions\/([a-f0-9-]+)\/plugins(?:\/([a-f0-9-]+))?$/);
  if(match) {
    if(!match[2]&&request.method==='GET') return response({accounts:await selectedPlugins(ownerId,uuid.parse(match[1]))});
    if(match[2]&&['PUT','DELETE'].includes(request.method)) {await attachPlugin(ownerId,match[1],match[2],request.method==='PUT');return response({ok:true});}
  }
  return null;
}
