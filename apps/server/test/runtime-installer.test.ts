import {mkdtempSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {sha256} from '../../../packages/box/runtime-release';
import {test,expect} from 'bun:test';
import {verifiedInstallerBootstrap} from '../src/runtime-updates';

function installerFixture(check:(path:string,payload:string)=>void){
 const directory=mkdtempSync(join(tmpdir(),'runtime-bootstrap-test-'));
 const path=join(directory,'installer.py'),payload='import json,sys\nprint(json.dumps({"verified":True,"arguments":sys.argv[1:]}))\n';
 try{writeFileSync(path,payload);check(path,payload);}finally{rmSync(directory,{recursive:true,force:true});}
}
test('privileged bootstrap executes the verified bytes even if the staging path changes during checksum verification',()=>{
 installerFixture((path,payload)=>{
  const race=`import hashlib,sys\nfrom pathlib import Path\ntarget=sys.argv[1]\noriginal=hashlib.sha256\ndef replace_during_verification(data):\n Path(target).write_text('raise RuntimeError("UNVERIFIED_CODE_EXECUTED")')\n return original(data)\nhashlib.sha256=replace_during_verification\n`;
  const result=Bun.spawnSync(['python3','-I','-c',race+verifiedInstallerBootstrap,path,sha256(Buffer.from(payload)),'probe'],{stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({verified:true,arguments:['probe']});
  expect(readFileSync(path,'utf8')).toContain('UNVERIFIED_CODE_EXECUTED');
 });
});
test('privileged bootstrap rejects altered bytes and symlinks without executing the staged program',()=>{
 installerFixture((path,payload)=>{
  const digest=sha256(Buffer.from(payload));
  writeFileSync(path,'raise RuntimeError("UNVERIFIED_CODE_EXECUTED")');
  const altered=Bun.spawnSync(['python3','-I','-c',verifiedInstallerBootstrap,path,digest,'probe'],{stdout:'pipe',stderr:'pipe'});
  expect(altered.exitCode).toBe(1);
  expect(JSON.parse(altered.stdout.toString())).toEqual({state:'failed',code:'INSTALLER_CHECKSUM_MISMATCH'});
  writeFileSync(path,payload);symlinkSync(path,path+'.link');
  const linked=Bun.spawnSync(['python3','-I','-c',verifiedInstallerBootstrap,path+'.link',digest,'probe'],{stdout:'pipe',stderr:'pipe'});
  expect(linked.exitCode).toBe(1);
  expect(JSON.parse(linked.stdout.toString())).toEqual({state:'failed',code:'INSTALLER_CHECKSUM_MISMATCH'});
 });
});

test('privileged bootstrap ignores modules planted in the working directory or PYTHONPATH',()=>{
 installerFixture((path,payload)=>{
  writeFileSync(join(dirname(path),'hashlib.py'),'raise RuntimeError("UNVERIFIED_MODULE_EXECUTED")');
  const result=Bun.spawnSync(['python3','-I','-c',verifiedInstallerBootstrap,path,sha256(Buffer.from(payload)),'probe'],{
   cwd:dirname(path),env:{...process.env,PYTHONPATH:dirname(path)},stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({verified:true,arguments:['probe']});
 });
});
