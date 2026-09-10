import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { MachinePlugin } from './catalog';
import { PluginFailure } from './execution';

/** Each stdio server owns a Linux process group, including ordinary child processes. */
export class OwnedStdioTransport implements Transport {
  onclose?:Transport['onclose'];onerror?:Transport['onerror'];onmessage?:Transport['onmessage'];
  private child?:ChildProcessWithoutNullStreams;
  private closed=false;
  private closing?:Promise<void>;
  constructor(private readonly plugin:MachinePlugin){}
  async start(){
    if(this.closed||this.child)throw new PluginFailure('PLUGIN_CONNECTION_FAILED');
    const child=spawn(this.plugin.command!,this.plugin.args??[],{detached:true,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME??'/home/user',...this.plugin.env},stdio:['pipe','pipe','pipe']});
    this.child=child;
    // Drain without logging: stderr may contain provider payloads or credentials.
    child.stderr.resume();
    const buffer=new ReadBuffer();
    child.stdout.on('data',chunk=>{if(this.closed)return;try{buffer.append(chunk);let message;while((message=buffer.readMessage())!==null)this.onmessage?.(message);}catch{this.onerror?.(new PluginFailure('PLUGIN_REMOTE_FAILED'));void this.close();}});
    child.on('error',()=>{this.onerror?.(new PluginFailure('PLUGIN_CONNECTION_FAILED'));void this.close();});
    child.stdin.on('error',()=>this.onerror?.(new PluginFailure('PLUGIN_REMOTE_FAILED')));
    child.stdout.on('error',()=>this.onerror?.(new PluginFailure('PLUGIN_REMOTE_FAILED')));
    child.on('close',()=>{if(!this.closed){this.closed=true;this.onclose?.();}});
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new PluginFailure('PLUGIN_CONNECTION_FAILED')));});
  }
  async send(message:JSONRPCMessage){
    if(this.closed||!this.child)throw new PluginFailure('PLUGIN_CONNECTION_FAILED');
    await new Promise<void>((resolve,reject)=>this.child!.stdin.write(serializeMessage(message),error=>error?reject(new PluginFailure('PLUGIN_REMOTE_FAILED')):resolve()));
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;this.onclose?.();
    const child=this.child;
    this.closing=(async()=>{
      if(!child?.pid)return;
      const kill=(signal:NodeJS.Signals)=>{try{process.kill(-child.pid!,signal);}catch{/* Owned group already exited. */}};
      // Signal the group even when its leader exited but left inherited pipes open.
      kill('SIGTERM');child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
      await new Promise<void>(resolve=>setTimeout(resolve,100));
      kill('SIGKILL');
    })();
    return this.closing;
  }
}
