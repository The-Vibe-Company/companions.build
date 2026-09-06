import {beforeAll,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {db,migrate} from '../src/store';
import {addCustomPlugin,checkPluginAccount,handlePlugins,listPluginAccounts,pluginCallbackLocation,pluginConnectionAvailable,startPluginConnection} from '../src/plugins';
import {decrypt,encrypt} from '../src/config';
import {CompanionPluginOAuthRevokedError,type CompanionPluginStoredOAuthCredential} from '../../../packages/plugins/oauth';

const owner='00000000-0000-4000-8000-000000000001';
beforeAll(async()=>{await migrate();});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

test('catalog availability is truthful for deployment-configured and dynamic OAuth',async()=>{
 expect(pluginConnectionAvailable('app.linear/linear',{})).toBe(true);
 expect(pluginConnectionAvailable('io.github.github/github-mcp-server',{})).toBe(false);
 expect(pluginConnectionAvailable('io.github.github/github-mcp-server',{COMPANION_MCP_GITHUB_CLIENT_ID:'id',COMPANION_MCP_GITHUB_CLIENT_SECRET:'secret'})).toBe(true);
 await expect(startPluginConnection(owner,'io.github.github/github-mcp-server','GitHub',{})).rejects.toThrow('unavailable in this deployment');
});

test('OAuth cancellation consumes only its owner state and stale callbacks return a safe connection route',async()=>{
 const state=crypto.randomUUID()+crypto.randomUUID(),other=crypto.randomUUID();
 await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${other},'Other',${other+'@example.test'},true)`;
 await db`INSERT INTO plugin_oauth_flows(state_hash,owner_id,label,flow_secret,expires_at) VALUES(${digest(state)},${owner},'Linear','unused',now()+interval '10 minutes')`;
 const crossOwner=await handlePlugins(new Request(`http://local/api/plugins/callback?state=${state}&error=access_denied`),other);
 expect(crossOwner?.status).toBe(303);expect(crossOwner?.headers.get('location')).toBe(pluginCallbackLocation('error'));
 expect((await db`SELECT consumed_at FROM plugin_oauth_flows WHERE state_hash=${digest(state)}`)[0].consumed_at).toBeNull();
 const cancelled=await handlePlugins(new Request(`http://local/api/plugins/callback?state=${state}&error=access_denied`),owner);
 expect(cancelled?.headers.get('location')).toBe(pluginCallbackLocation('cancelled'));
 expect((await db`SELECT consumed_at FROM plugin_oauth_flows WHERE state_hash=${digest(state)}`)[0].consumed_at).not.toBeNull();
 const replay=await handlePlugins(new Request(`http://local/api/plugins/callback?state=${state}&error=access_denied`),owner);
 expect(replay?.headers.get('location')).toBe(pluginCallbackLocation('error'));
});

function oauthCredential(expiresAt:string|null=new Date(Date.now()+3600_000).toISOString()):CompanionPluginStoredOAuthCredential{return{
 kind:'oauth',version:1,serverName:'app.linear/linear',accessToken:'private-access',refreshToken:'private-refresh',accessExpiresAt:expiresAt,scope:'read write',tokenType:'Bearer',
 tokenEndpoint:'https://mcp.linear.app/token',resource:'https://mcp.linear.app/mcp',client:{clientId:'client',clientSecret:null,tokenEndpointAuthMethod:'none'},
};}
async function oauthAccount(ownerId=owner,credential=oauthCredential()){
 const id=crypto.randomUUID();await db`INSERT INTO plugin_accounts(id,owner_id,provider,label,server_id,credential_secret) VALUES(${id},${ownerId},'linear','Linear','app.linear/linear',${encrypt(JSON.stringify(credential))})`;return id;
}

test('owned OAuth health performs discovery only and persists a secret-free projection',async()=>{
 const id=await oauthAccount();const checkedAt=new Date('2026-09-07T12:00:00.000Z');let calls=0;
 const result=await checkPluginAccount(owner,id,{now:()=>checkedAt,async check(plugin){calls++;expect(plugin).toMatchObject({id,provider:'linear',transport:'http',url:'https://mcp.linear.app/mcp'});expect(plugin.headers?.Authorization).toBe('Bearer private-access');}});
 expect(calls).toBe(1);expect(result).toEqual({id,healthStatus:'ok',healthCode:null,checkedAt});
 const listed=(await listPluginAccounts(owner)).find((account:any)=>account.id===id);
 expect(listed).toMatchObject({healthStatus:'ok',healthCode:null});expect(new Date(listed.checkedAt).toISOString()).toBe(checkedAt.toISOString());expect(JSON.stringify(listed)).not.toContain('private-access');
});

test('expired OAuth refreshes before discovery and a revoked grant asks for authorization without raw errors',async()=>{
 const refreshedId=await oauthAccount(owner,oauthCredential(new Date(Date.now()-60_000).toISOString()));let discovered='';
 const refreshed=await checkPluginAccount(owner,refreshedId,{async refresh({credential}){return{...credential,accessToken:'rotated-private',accessExpiresAt:new Date(Date.now()+3600_000).toISOString()};},async check(plugin){discovered=plugin.headers?.Authorization??'';}});
 expect(refreshed).toMatchObject({healthStatus:'ok',healthCode:null});expect(discovered).toBe('Bearer rotated-private');
 const [stored]=await db`SELECT credential_secret FROM plugin_accounts WHERE id=${refreshedId}`;expect(decrypt(stored.credential_secret)).toContain('rotated-private');

 const revokedId=await oauthAccount(owner,oauthCredential(new Date(Date.now()-60_000).toISOString()));
 const revoked=await checkPluginAccount(owner,revokedId,{async refresh(){throw new CompanionPluginOAuthRevokedError();},async check(){throw Error('must not discover');}});
 expect(revoked).toMatchObject({healthStatus:'error',healthCode:'authorization_required'});expect(JSON.stringify(revoked)).not.toContain('private');
});

test('connection failures are expurgated, cross-owner checks do nothing, and custom MCP stays agent-only',async()=>{
 const id=await oauthAccount();let checks=0;
 const failed=await checkPluginAccount(owner,id,{async check(){checks++;throw Error('provider raw token private-access');}});
 expect(failed).toMatchObject({healthStatus:'error',healthCode:'connection_failed'});expect(JSON.stringify(failed)).not.toContain('provider raw');
 expect(await checkPluginAccount(crypto.randomUUID(),id,{async check(){checks++;}})).toBeNull();expect(checks).toBe(1);

 const custom=await addCustomPlugin(owner,{label:'Local private',transport:'stdio',command:'/usr/bin/private-mcp',env:{TOKEN:'private'}});
 const endpoint=await handlePlugins(new Request(`http://local/api/plugins/accounts/${custom.id}/check`,{method:'POST'}),owner);
 expect(endpoint?.status).toBe(200);expect(await endpoint?.json()).toMatchObject({account:{id:custom.id,healthStatus:'requires_agent',healthCode:'agent_check_required'}});
});
