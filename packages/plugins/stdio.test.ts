import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pluginTools } from './tools';
const linuxTest=process.env.RUN_PLUGIN_STDIO_TESTS==='1'?test:test.skip;
for(const mode of ['normal','blocked','disconnect'])linuxTest(`owned stdio ${mode} finishes and kills its process group`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'plugin-stdio-')),pids=join(dir,'pids');
  const connection=pluginTools(()=>[{id:'stdio',provider:'custom',name:'Fixture',transport:'stdio',command:process.execPath,args:['--no-env-file',join(import.meta.dir,'stdio-fixture.ts'),mode,pids],env:{RUN_PLUGIN_STDIO_TESTS:'1'}}],{limits:{operation:2000,connect:1000,discover:1000,call:100,cleanup:500}});
  try{
    const result=await connection.tools[1]!.execute('stdio-call',{connectionId:'stdio',tool:'mutate',arguments:{}},undefined,undefined,{} as never);
    if(mode==='normal')expect(result.content).toEqual([{type:'text',text:'observed stdio result'}]);
    else expect(result.details).toEqual({isError:true});
    if(mode==='blocked'){
      const recorded=JSON.parse(readFileSync(pids,'utf8'));
      // Zombies have stopped executing and are reaped by Docker's init.
      for(const pid of [recorded.parent,recorded.child]){
        const path=`/proc/${pid}/stat`;
        const stopped=()=>!existsSync(path)||readFileSync(path,'utf8').split(' ')[2]==='Z';
        for(let i=0;i<100&&!stopped();i++)await Bun.sleep(5);
        expect(stopped()).toBe(true);
      }
    }
  }finally{await connection.close();rmSync(dir,{recursive:true,force:true});}
});
