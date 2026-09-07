import {beforeAll,expect,test} from 'bun:test';
import {db,migrate} from '../src/store';
import {encrypt} from '../src/config';
import {overrideSpecialistConnection,synchronizeSpecialistConnections} from '../src/specialist-connections';

beforeAll(()=>migrate());

test('an accepted intervention keeps its revision connections after a later publication',async()=>{
 const owner=crypto.randomUUID(),parent=crypto.randomUUID(),template=crypto.randomUUID(),child=crypto.randomUUID();
 const github=crypto.randomUUID(),linear=crypto.randomUUID();
 await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${owner},'Owner',${owner+'@example.test'},true)`;
 await db`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,prepare_requested)
  VALUES(${parent},${owner},'Parent','','local',${crypto.randomUUID()},'secret',false)`;
 await db`INSERT INTO agent_templates(id,owner_id,name,instructions,revision) VALUES(${template},${owner},'Developer','',2)`;
 await db`INSERT INTO template_permissions(parent_id,template_id,max_children) VALUES(${parent},${template},2)`;
 await db`INSERT INTO plugin_accounts(id,owner_id,provider,label,server_id,credential_secret) VALUES
  (${github},${owner},'github','GitHub','github-server',${encrypt('{}')}),
  (${linear},${owner},'linear','Linear','linear-server',${encrypt('{}')})`;
 await db`INSERT INTO companion_plugins(companion_id,account_id) VALUES(${parent},${github}),(${parent},${linear})`;
 await db`INSERT INTO specialist_connections(template_id,slot,account_id,required,provider,label,server_id)
  VALUES(${template},'issues',${linear},true,'linear','Linear','linear-server')`;
 await db`INSERT INTO specialist_revision_connections(template_id,revision,slot,account_id,required,provider,label,server_id) VALUES
  (${template},1,'code',${github},true,'github','GitHub','github-server'),
  (${template},2,'issues',${linear},true,'linear','Linear','linear-server')`;
 await db`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,parent_id,temporary,template_id,template_revision,prepare_requested)
  VALUES(${child},${owner},'Developer','','local',${crypto.randomUUID()},'child-secret',${parent},true,${template},1,false)`;

 await synchronizeSpecialistConnections(child);
 expect((await db`SELECT account_id FROM companion_plugins WHERE companion_id=${child}`).map((row:any)=>row.account_id)).toEqual([github]);
 await expect(overrideSpecialistConnection(owner,parent,template,{slot:'issues',accountId:github})).rejects.toThrow('compatible connection');
});
