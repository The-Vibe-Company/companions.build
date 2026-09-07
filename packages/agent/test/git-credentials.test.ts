import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitCredentialBroker,runGitCredentialHelper} from '../../control/git-credentials';
import type {MachinePlugin} from '../../plugins/catalog';

const owned:string[]=[];
afterEach(()=>{for(const path of owned.splice(0))rmSync(path,{recursive:true,force:true});});

function state(){const path=mkdtempSync(join(tmpdir(),'companion-git-credentials-'));owned.push(path);return path;}
function plugin(id:string,token:string):MachinePlugin{return {id,name:'GitHub',provider:'github',transport:'http',url:'https://api.githubcopilot.com/mcp/',headers:{Authorization:`Bearer ${token}`}};}
function input(value:string){return new Blob([value]).stream();}

describe('GitCredentialBroker',()=>{
  test('serves one selected GitHub credential without persisting its token',async()=>{
    const directory=state(),broker=new GitCredentialBroker(directory),token='github-secret-fixture';
    try{
      broker.update([plugin('github-one',token)]);
      let output='';
      expect(await runGitCredentialHelper(broker.socketPath,'get',input('protocol=https\nhost=github.com\npath=owner/private.git\n\n'),value=>{output+=value;})).toBe(0);
      expect(output).toBe(`username=x-access-token\npassword=${token}\n\n`);
      for(const name of readdirSync(directory)){
        if(name.endsWith('.sock'))continue;
        expect(readFileSync(join(directory,name)).includes(token)).toBe(false);
      }
    }finally{broker.close();}
  });

  test('does not answer non-GitHub or non-HTTPS credential requests',async()=>{
    const broker=new GitCredentialBroker(state());broker.update([plugin('github-one','secret')]);
    try{
      let output='';
      expect(await runGitCredentialHelper(broker.socketPath,'get',input('protocol=https\nhost=gitlab.com\n\n'),value=>{output+=value;})).toBe(0);
      expect(await runGitCredentialHelper(broker.socketPath,'get',input('protocol=http\nhost=github.com\n\n'),value=>{output+=value;})).toBe(0);
      expect(output).toBe('');
    }finally{broker.close();}
  });

  test('refuses to choose between multiple selected GitHub accounts',async()=>{
    const broker=new GitCredentialBroker(state());broker.update([plugin('github-one','secret-one'),plugin('github-two','secret-two')]);
    try{
      let output='';
      expect(await runGitCredentialHelper(broker.socketPath,'get',input('protocol=https\nhost=github.com\n\n'),value=>{output+=value;})).toBe(2);
      expect(output).toBe('');
    }finally{broker.close();}
  });

  test('configures clean URLs to use the compiled helper and disables prompts',()=>{
    const broker=new GitCredentialBroker(state());
    try{
      const environment=broker.environment('/opt/companions/companion-agent',{});
      expect(environment.GIT_TERMINAL_PROMPT).toBe('0');
      expect(environment.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
      expect(environment.GIT_CONFIG_VALUE_0).toContain("'/opt/companions/companion-agent' --git-credential-helper");
      expect(JSON.stringify(environment)).not.toContain('Bearer');
    }finally{broker.close();}
  });
});
