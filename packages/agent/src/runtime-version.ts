import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

// Read once: replacing files on disk must never change a running process's identity.
export const runtimeVersion:string|null=(()=>{
  try{
    const value=JSON.parse(readFileSync(join(dirname(process.execPath),'runtime-release.json'),'utf8'));
    return value.schemaVersion===1&&value.protocolVersion===1&&value.stateVersion===1&&/^[a-f0-9]{64}$/.test(value.id)?value.id:null;
  }catch{return null;}
})();
