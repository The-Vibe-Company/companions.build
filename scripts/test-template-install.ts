/** Optional local Linux proof. No Box calls, credentials, or host lifecycle commands. */
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {templateInstallScript} from './lib/template-install';
const artifact=resolve(`.artifacts/template-install-${crypto.randomUUID()}`);
mkdirSync(artifact,{recursive:true});
await Bun.write(`${artifact}/installation.sh`,templateInstallScript(`/tmp/companions-${'0'.repeat(16)}`,'0'.repeat(64)));
const child=Bun.spawn(['docker','run','--rm','--platform','linux/amd64',
 '--mount',`type=bind,src=${artifact}/installation.sh,dst=/installation.sh,readonly`,
 '--mount',`type=bind,src=${resolve('experiments/desktop-boundary/template-install.py')},dst=/test.py,readonly`,
 'companions-desktop-boundary:proof','python3','/test.py'],{stdout:'inherit',stderr:'inherit'});
process.exitCode=await child.exited;
