import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from './store';
import { encrypt, decrypt } from './config';
import { pluginCatalog, type MachinePlugin } from '../../../packages/plugins/catalog';
import { beginCompanionPluginOAuth, completeCompanionPluginOAuth, refreshCompanionPluginOAuth, COMPANION_GMAIL_MCP_ALLOWED_TOOLS, type CompanionPluginStoredOAuthCredential } from '../../../packages/plugins/oauth';

const uuid = z.string().uuid();
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const callback = () => new URL('/api/plugins/callback', process.env.APP_URL ?? 'http://127.0.0.1:4310').href;
export async function migratePlugins(sql:any) { await sql.unsafe(await Bun.file(new URL('./plugins.sql',import.meta.url)).text()); }
export class PluginError extends Error {}
const publicColumns = db`id,provider,label,server_id AS "serverId",created_at AS "createdAt"`;
export async function listPluginAccounts(ownerId:string) { return db`SELECT ${publicColumns} FROM plugin_accounts WHERE owner_id=${ownerId} ORDER BY created_at`; }
export async function startPluginConnection(ownerId:string, serverId:string, label:string) {
  const provider = pluginCatalog.find(p => p.id === serverId);
  if(!provider) throw new PluginError('Choose an available plugin.');
  const state=randomBytes(32).toString('base64url');
  const {authorizationUrl,flow}=await beginCompanionPluginOAuth({serverName:serverId,state,redirectUri:callback()});
  await db`INSERT INTO plugin_oauth_flows (state_hash,owner_id,label,flow_secret,expires_at) VALUES (${hash(state)},${ownerId},${label.slice(0,80)||provider.name},${encrypt(JSON.stringify(flow))},now()+interval '10 minutes')`;
  return {url:authorizationUrl};
}
export async function completePluginConnection(ownerId:string,state:string,code:string) {
  const [row]=await db`UPDATE plugin_oauth_flows SET consumed_at=now() WHERE state_hash=${hash(state)} AND owner_id=${ownerId} AND consumed_at IS NULL AND expires_at>now() RETURNING *`;
  if(!row) throw new PluginError('This connection link expired. Connect again.');
  const flow=JSON.parse(decrypt(row.flow_secret));
  const credential=await completeCompanionPluginOAuth({flow,code,redirectUri:callback()});
  const id=crypto.randomUUID();
  await db`INSERT INTO plugin_accounts (id,owner_id,provider,label,server_id,credential_secret) VALUES (${id},${ownerId},${flow.provider},${row.label},${flow.serverName},${encrypt(JSON.stringify(credential))})`;
  return {id};
}
const customSchema=z.object({label:z.string().trim().min(1).max(80),transport:z.enum(['http','stdio']).default('http'),url:z.string().url().optional(),command:z.string().min(1).max(500).optional(),args:z.array(z.string().max(2000)).max(50).default([]),headers:z.record(z.string(),z.string().max(8000)).default({}),env:z.record(z.string(),z.string().max(8000)).default({})});
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
export async function handlePlugins(request:Request,ownerId:string):Promise<Response|null> {
  const url=new URL(request.url);const path=url.pathname;
  if(path==='/api/plugins' && request.method==='GET') return response({catalog:pluginCatalog,accounts:await listPluginAccounts(ownerId)});
  if(path==='/api/plugins/connect' && request.method==='POST') {const v=z.object({serverId:z.string(),label:z.string().max(80).default('')}).parse(await request.json());return response(await startPluginConnection(ownerId,v.serverId,v.label));}
  if(path==='/api/plugins/custom' && request.method==='POST') return response(await addCustomPlugin(ownerId,await request.json()),201);
  if(path==='/api/plugins/callback' && request.method==='GET') {
    await completePluginConnection(ownerId,z.string().min(20).max(200).parse(url.searchParams.get('state')),z.string().min(1).max(4000).parse(url.searchParams.get('code')));
    return new Response(null,{status:303,headers:{location:new URL('/settings/connections',process.env.APP_URL??'http://127.0.0.1:4310').href,'cache-control':'no-store'}});
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
