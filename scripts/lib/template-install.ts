import {userSystemctl} from '../../packages/box/layout';

/** Loading the executable must reach the no-credentials guard, without starting work. */
export const runtimeProbeScript=`set -eu
runtime_probe="$(mktemp)"
trap 'rm -f "$runtime_probe"' EXIT
if env -u AGENT_TOKEN /opt/companions/companion-agent >"$runtime_probe" 2>&1; then exit 1; fi
test "$(cat "$runtime_probe")" = MISSING_AGENT_TOKEN`;

/** Used only on an owned distribution-build Box, never on a Companion's wake path. */
export function templateInstallScript(directory:string,digest:string){
 if(!/^[a-f0-9]{64}$/.test(digest)||directory!==`/tmp/companions-${digest.slice(0,16)}`)throw Error('INVALID_DISTRIBUTION_STAGING');
 return `set -eu
${userSystemctl('thaw companions-agent.service')} 2>/dev/null || true
${userSystemctl('disable --now companions-agent.service')} 2>/dev/null || true
sudo -n systemctl stop companions-agent-proxy.socket companions-agent-proxy.service companions-agent.service companions-desktop.service 2>/dev/null || true
case "$(${userSystemctl('is-active companions-agent.service')} 2>/dev/null || true)" in inactive|failed|unknown) ;; *) exit 1;; esac
for unit in companions-agent-proxy.socket companions-agent-proxy.service companions-agent.service companions-desktop.service; do
 case "$(sudo -n systemctl is-active "$unit" 2>/dev/null || true)" in inactive|failed|unknown) ;; *) exit 1;; esac
done
sudo -n python3 - <<'INSTALL'
import ctypes
import hashlib
import os
from pathlib import Path
import shutil
import subprocess

archive=Path('${directory}/agent.tar.gz')
if hashlib.sha256(archive.read_bytes()).hexdigest()!='${digest}':
    raise SystemExit('DISTRIBUTION_CHECKSUM_MISMATCH')
target=Path('/opt/companions')
staged=Path('/opt/.companions-build-${digest}')
legacy=Path('/home/user/.companions-dist')
# No symlink traversal or generic cleanup outside these product distribution directories.
for path in [target,staged,legacy]:
    if path.is_symlink(): raise SystemExit('UNSAFE_DISTRIBUTION_DIRECTORY')
if staged.exists(): shutil.rmtree(staged)
staged.mkdir(parents=True)
subprocess.run(['tar','-xzf',str(archive),'-C',str(staged)],check=True)
subprocess.run(['chown','-R','root:root',str(staged)],check=True)
if not (staged/'companion-agent').is_file() or not (staged/'install-desktop.sh').is_file():
    raise SystemExit('INCOMPLETE_DISTRIBUTION')
if target.exists():
    # Both directories are on /opt. Exchange names atomically even if an old reader
    # still maps its executable; never truncate an executable in place (ETXTBSY).
    libc=ctypes.CDLL(None,use_errno=True)
    exchange=libc.renameat2
    exchange.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    if exchange(-100,os.fsencode(staged),-100,os.fsencode(target),2)!=0:
        raise OSError(ctypes.get_errno(),'DISTRIBUTION_EXCHANGE_FAILED')
else:
    staged.rename(target)
subprocess.run(['sh',str(target/'install-desktop.sh')],check=True)
if (target/'desktop-boundary.version').read_text().strip()!='1':
    raise SystemExit('DISTRIBUTION_INSTALL_UNCONFIRMED')
# Only after successful installation: remove the exchanged old distribution and
# the obsolete legacy executable copy. Pi state and user files are never touched.
if staged.exists(): shutil.rmtree(staged)
if legacy.exists(): shutil.rmtree(legacy)
INSTALL
${runtimeProbeScript}`;
}
