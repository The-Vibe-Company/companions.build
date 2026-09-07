/** Optional local Linux proof of the exact remote read-only hash command. No Box calls. */
import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {distributionVerificationCommand,type DistributionManifest} from './lib/distribution-verification';
import {requirePinnedBun} from './lib/pinned-bun';
requirePinnedBun();
const directory=resolve(`.artifacts/distribution-verification-${crypto.randomUUID()}`);
mkdirSync(directory,{recursive:true});
const manifest:DistributionManifest={version:1,files:['companion-agent','helper.py','resource.wasm'].map(path=>({path,size:3,sha256:createHash('sha256').update('new').digest('hex')}))};
await Bun.write(`${directory}/verify.sh`,distributionVerificationCommand(manifest));
await Bun.write(`${directory}/manifest.json`,JSON.stringify(manifest));
await Bun.write(`${directory}/test.py`,String.raw`import json,os,subprocess
from pathlib import Path
root=Path('/opt/companions');root.mkdir(parents=True)
stub=Path('/tmp/verification-bin');stub.mkdir()
sudo=stub/'sudo';sudo.write_text('#!/bin/sh\n[ "$1" != -n ] || shift\nexec "$@"\n');sudo.chmod(0o755)
os.environ['PATH']=str(stub)+':'+os.environ['PATH']
expected=json.loads(Path('/fixture/manifest.json').read_text())
for entry in expected['files']:(root/entry['path']).write_bytes(b'new')
def observed():
 result=subprocess.run(['sh','/fixture/verify.sh'],capture_output=True,text=True,check=True,timeout=10)
 return json.loads(result.stdout)
assert observed()==expected
(root/'helper.py').write_bytes(b'old')
assert observed()!=expected
(root/'helper.py').write_bytes(b'new')
(root/'companion-agent').unlink();(root/'companion-agent').symlink_to('/etc/passwd')
assert all(entry['path']!='companion-agent' for entry in observed()['files'])
print('PASS exact Linux hash command: all files, stale helper rejected, symlink excluded')
`);
const child=Bun.spawn(['docker','run','--rm','--platform','linux/amd64','--mount',`type=bind,src=${directory},dst=/fixture,readonly`,'companions-desktop-boundary:proof','python3','/fixture/test.py'],{stdout:'inherit',stderr:'inherit'});
process.exitCode=await child.exited;
