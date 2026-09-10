// Executed only by the Docker Linux transport test.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if(process.env.RUN_PLUGIN_STDIO_TESTS!=='1')throw Error('DOCKER_FIXTURE_REQUIRED');
const mode=process.argv[2];
if(mode==='child'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else {
  if(mode==='blocked'){
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['--no-env-file',import.meta.path,'child'],{env:{RUN_PLUGIN_STDIO_TESTS:'1'},stdio:'ignore'});
    writeFileSync(process.argv[3]!,JSON.stringify({parent:process.pid,child:child.pid}));
  }
  const input=createInterface({input:process.stdin});
  input.on('line',line=>{
    const m=JSON.parse(line);if(m.id===undefined)return;
    let result;
    if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if(m.method==='tools/list')result={tools:[{name:'mutate',inputSchema:{type:'object',properties:{}}}]};
    else if(mode==='blocked')return;
    else if(mode==='disconnect')return process.exit(0);
    else result={content:[{type:'text',text:'observed stdio result'}]};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
  });
}
