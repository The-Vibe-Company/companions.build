import {afterAll,beforeAll,expect,test} from 'bun:test';
import {db,createCompanion,migrate} from '../src/store';

const owner='00000000-0000-4000-8000-000000000001';

beforeAll(async()=>{await migrate();});
afterAll(async()=>{await db.close();});

test('legacy removal refuses ambiguous provider resources and preserves permanent state layout',async()=>{
 const permanent=await createCompanion(owner,{name:'Existing permanent'});
 const temporary=await createCompanion(owner,{name:'Old temporary'});
 await db.unsafe(`
  ALTER TABLE companions ADD COLUMN IF NOT EXISTS temporary boolean NOT NULL DEFAULT false;
  ALTER TABLE companions ADD COLUMN IF NOT EXISTS specialist_draft_id uuid;
  ALTER TABLE companions ADD COLUMN IF NOT EXISTS template_id uuid;
  CREATE TABLE portable_software_usage_intervals(id uuid PRIMARY KEY,ended_at timestamptz);
  CREATE TABLE portable_software_builds(id uuid PRIMARY KEY,box_id text,create_started_at timestamptz,cleanup_status text NOT NULL);
 `);
 await db`UPDATE companions SET template_id=${crypto.randomUUID()} WHERE id=${permanent.id}`;
 await db`UPDATE companions SET temporary=true,box_id='legacy-box',create_started_at=now() WHERE id=${temporary.id}`;
 await db`INSERT INTO portable_software_usage_intervals(id) VALUES(${crypto.randomUUID()})`;
 await db`INSERT INTO portable_software_builds(id,box_id,cleanup_status) VALUES(${crypto.randomUUID()},'software-box','pending')`;
 await db`DELETE FROM companions_schema_state`;

 await expect(migrate()).rejects.toThrow('portable software usage is unreconciled');
 await db`UPDATE portable_software_usage_intervals SET ended_at=now()`;
 await expect(migrate()).rejects.toThrow('portable software machines are not confirmed archived');
 await db`UPDATE portable_software_builds SET cleanup_status='complete'`;
 const uncertainCreate=crypto.randomUUID();
 await db`INSERT INTO portable_software_builds(id,create_started_at,cleanup_status) VALUES(${uncertainCreate},now(),'pending')`;
 await expect(migrate()).rejects.toThrow('portable software machines are not confirmed archived');
 expect((await db`SELECT box_id,create_started_at FROM portable_software_builds WHERE id=${uncertainCreate}`)[0]).toMatchObject({box_id:null,create_started_at:expect.any(Date)});
 await db`UPDATE portable_software_builds SET cleanup_status='complete' WHERE id=${uncertainCreate}`;
 await expect(migrate()).rejects.toThrow('specialist machines are not confirmed archived');
 await db`UPDATE companions SET archive_requested_at=now(),archived_at=now() WHERE id=${temporary.id}`;

 expect((await migrate()).applied).toBe(true);
 const [layout]=await db`SELECT agent_state_layout FROM companions WHERE id=${permanent.id}`;
 expect(layout.agent_state_layout).toBe('per_companion');
 const [removed]=await db`SELECT to_regclass('public.portable_software_builds') AS builds,
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='companions' AND column_name='template_id') AS template_column`;
 expect(removed).toEqual({builds:null,template_column:false});
});
