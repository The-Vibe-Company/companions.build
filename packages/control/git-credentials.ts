import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachinePlugin } from '../plugins/catalog';

const MAX_CREDENTIAL_INPUT_BYTES=8*1024;
const GITHUB_HOST='github.com';

type CredentialState=
  |{kind:'available';token:string}
  |{kind:'ambiguous'}
  |{kind:'unavailable'};

/** Keeps GitHub OAuth credentials in memory and exposes them only over a private Unix socket. */
export class GitCredentialBroker {
  readonly socketPath:string;
  private readonly runtimeDir:string;
  private credential:CredentialState={kind:'unavailable'};
  private readonly server:ReturnType<typeof Bun.serve>;
  private closed=false;

  constructor(_stateDir:string) {
    this.runtimeDir=mkdtempSync(join(tmpdir(),'companions-git-credentials-'));
    chmodSync(this.runtimeDir,0o700);
    this.socketPath=join(this.runtimeDir,'broker.sock');
    try{
      this.server=Bun.serve({unix:this.socketPath,fetch:request=>this.handle(request)});
      chmodSync(this.socketPath,0o600);
    }catch(error){
      rmSync(this.runtimeDir,{recursive:true,force:true});
      throw error;
    }
  }

  update(plugins:MachinePlugin[]) {
    const github=plugins.filter(plugin=>plugin.provider==='github');
    const token=github.length===1?bearerToken(Object.entries(github[0].headers??{}).find(([name])=>name.toLowerCase()==='authorization')?.[1]):null;
    this.credential=github.length>1?{kind:'ambiguous'}:token?{kind:'available',token}:{kind:'unavailable'};
  }

  environment(executable=process.execPath,current:Readonly<Record<string,string|undefined>>=process.env):Record<string,string> {
    const count=parseConfigCount(current.GIT_CONFIG_COUNT);
    return {
      GIT_TERMINAL_PROMPT:'0',
      GIT_CONFIG_COUNT:String(count+3),
      // An empty helper resets inherited store/cache helpers for GitHub. Otherwise
      // Git sends the broker token to every helper after successful authentication.
      [`GIT_CONFIG_KEY_${count}`]:`credential.https://${GITHUB_HOST}.helper`,
      [`GIT_CONFIG_VALUE_${count}`]:'',
      [`GIT_CONFIG_KEY_${count+1}`]:`credential.https://${GITHUB_HOST}.helper`,
      [`GIT_CONFIG_VALUE_${count+1}`]:`!${shellQuote(executable)} --git-credential-helper ${shellQuote(this.socketPath)}`,
      [`GIT_CONFIG_KEY_${count+2}`]:'credential.useHttpPath',
      [`GIT_CONFIG_VALUE_${count+2}`]:'true',
    };
  }

  close() {
    if(this.closed)return;this.closed=true;
    this.credential={kind:'unavailable'};
    this.server.stop(true);
    rmSync(this.runtimeDir,{recursive:true,force:true});
  }

  private handle(request:Request):Response {
    const url=new URL(request.url);
    if(request.method!=='POST'||url.pathname!=='/credential')return new Response(null,{status:404});
    if(request.headers.get('content-length')&&Number(request.headers.get('content-length'))>MAX_CREDENTIAL_INPUT_BYTES)return new Response('INVALID_CREDENTIAL_REQUEST',{status:400});
    if(this.credential.kind==='ambiguous')return new Response('GITHUB_CREDENTIAL_AMBIGUOUS',{status:409});
    if(this.credential.kind==='unavailable')return new Response('GITHUB_CREDENTIAL_UNAVAILABLE',{status:404});
    return Response.json({username:'x-access-token',password:this.credential.token});
  }
}

/** Git credential-helper entrypoint. Writes only the credential protocol to stdout. */
export async function runGitCredentialHelper(socketPath:string,operation:string,input:ReadableStream<Uint8Array>|null=Bun.stdin.stream(),write:(value:string)=>void|Promise<void>=value=>Bun.write(Bun.stdout,value).then(()=>{})):Promise<number> {
  if(operation==='store'||operation==='erase')return 0;
  if(operation!=='get'||!socketPath)return 1;
  const raw=await readBounded(input,MAX_CREDENTIAL_INPUT_BYTES);
  if(raw===null)return 1;
  const fields=parseCredentialInput(raw);
  if(fields.protocol!=='https'||normalizeHost(fields.host)!==GITHUB_HOST)return 0;
  let response:Response;
  try{
    response=await fetch('http://credential/credential',{method:'POST',unix:socketPath,headers:{'content-length':'0'}} as RequestInit&{unix:string});
  }catch{return 1;}
  if(!response.ok)return response.status===404?0:response.status===409?2:1;
  const credential=await response.json() as {username?:unknown;password?:unknown};
  if(typeof credential.username!=='string'||typeof credential.password!=='string'||invalidCredentialValue(credential.username)||invalidCredentialValue(credential.password))return 1;
  await write(`username=${credential.username}\npassword=${credential.password}\n\n`);
  return 0;
}

function bearerToken(value:string|undefined):string|null {
  if(typeof value!=='string')return null;
  const match=value.match(/^Bearer ([^\r\n\0]+)$/);
  return match?.[1]??null;
}

function parseConfigCount(raw:string|undefined):number {
  if(raw===undefined)return 0;
  const value=Number(raw);
  return Number.isSafeInteger(value)&&value>=0&&value<=100?value:0;
}

function shellQuote(value:string):string {
  return `'${value.replaceAll("'",`'\\''`)}'`;
}

async function readBounded(input:ReadableStream<Uint8Array>|null,limit:number):Promise<string|null> {
  if(!input)return '';
  const reader=input.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)return null;chunks.push(value);}
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}
}

function parseCredentialInput(raw:string):Record<string,string> {
  const result:Record<string,string>={};
  if(raw.includes('\0')||raw.includes('\r'))return result;
  for(const line of raw.split('\n')){
    if(line==='')break;
    const separator=line.indexOf('=');if(separator<1)continue;
    result[line.slice(0,separator)]=line.slice(separator+1);
  }
  return result;
}

function normalizeHost(value:string|undefined):string {
  if(!value)return '';
  try{return new URL(`https://${value}`).hostname.toLowerCase();}catch{return '';}
}

function invalidCredentialValue(value:string):boolean{return value.includes('\r')||value.includes('\n')||value.includes('\0');}
