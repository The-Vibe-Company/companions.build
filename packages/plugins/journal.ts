import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { PluginCall, PluginErrorCode } from './execution';

/** Metadata only. Arguments, credentials and provider response bodies stay out of this journal. */
export class PluginJournal {
  private readonly db:Database;
  constructor(stateDir:string){
    this.db=new Database(join(stateDir,'plugin-calls.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS plugin_calls(request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,record TEXT NOT NULL,UNIQUE(run_id,tool_call_id));
      CREATE TABLE IF NOT EXISTS plugin_versions(run_id TEXT PRIMARY KEY,version INTEGER NOT NULL);`);
  }
  get(runId:string,toolCallId:string):PluginCall|undefined {
    const row=this.db.query('SELECT record FROM plugin_calls WHERE run_id=? AND tool_call_id=?').get(runId,toolCallId) as {record:string}|null;
    return row?JSON.parse(row.record):undefined;
  }
  save(record:PluginCall){
    this.db.transaction(()=>{
      const prior=this.get(record.runId,record.toolCallId);
      // A late result cannot rewrite uncertainty or a terminal outcome.
      if(prior&&prior.status!=='running')return;
      this.db.query('INSERT INTO plugin_calls VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET record=excluded.record').run(record.requestId,record.runId,record.toolCallId,JSON.stringify(record));
      this.db.query('INSERT INTO plugin_versions VALUES(?,1) ON CONFLICT(run_id) DO UPDATE SET version=version+1').run(record.runId);
    }).immediate();
  }
  interrupt(runId?:string,code:PluginErrorCode='PLUGIN_RESTARTED'){
    const rows=this.db.query("SELECT record FROM plugin_calls WHERE json_extract(record,'$.status')='running' AND (? IS NULL OR run_id=?)").all(runId??null,runId??null) as {record:string}[];
    for(const row of rows){const call=JSON.parse(row.record) as PluginCall;this.save({...call,status:'interrupted',code,updatedAt:Date.now()});}
  }
  snapshot(runId:string):{pluginCalls:PluginCall[];pluginCallVersion:number}{
    return this.db.transaction(()=>{
      const row=this.db.query('SELECT version FROM plugin_versions WHERE run_id=?').get(runId) as {version:number}|null;
      const calls=this.db.query('SELECT record FROM plugin_calls WHERE run_id=? ORDER BY rowid').all(runId) as {record:string}[];
      return {pluginCalls:calls.map(row=>JSON.parse(row.record)),pluginCallVersion:row?.version??0};
    })();
  }
  close(){this.db.close(false);}
}
