import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export const runtimeFiles=['companion-agent','photon_rs_bg.wasm','package.json'] as const;
export type RuntimeRelease={schemaVersion:1;id:string;protocolVersion:1;stateVersion:1;files:{path:string;size:number;sha256:string}[]};
export const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export function runtimeRelease(directory:string):RuntimeRelease{
  const files=runtimeFiles.map(path=>{const bytes=readFileSync(join(directory,path));return {path,size:bytes.length,sha256:sha256(bytes)};});
  return {schemaVersion:1,id:sha256(JSON.stringify(files)),protocolVersion:1,stateVersion:1,files};
}
