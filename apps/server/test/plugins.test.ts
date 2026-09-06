import {beforeAll,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {db,migrate} from '../src/store';
import {handlePlugins,pluginCallbackLocation,pluginConnectionAvailable,startPluginConnection} from '../src/plugins';

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
