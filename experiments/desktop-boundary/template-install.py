"""Local Linux acceptance for the exact generated build-Box installation command."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess as S
import tarfile

assert os.getuid()==0
stub=Path('/tmp/stubs');stub.mkdir()
(stub/'sudo').write_text('#!/bin/sh\n[ "$1" != -n ] || shift\nexec "$@"\n')
(stub/'systemctl').write_text('''#!/bin/sh
printf '%s\n' "$*" >> /tmp/unit-calls
for arg in "$@"; do
 if [ "$arg" = is-active ]; then
  if [ -f /tmp/active ]; then echo active; else echo inactive; fi
  exit 3
 fi
done
exit 0
''')
for p in stub.iterdir():p.chmod(0o755)
os.environ['PATH']=str(stub)+':'+os.environ['PATH']
old=Path('/opt/companions');old.mkdir(parents=True)
shutil.copy('/usr/bin/sleep',old/'companion-agent')
legacy=Path('/home/user/.companions-dist');legacy.mkdir(parents=True)
(legacy/'companion-agent').write_bytes(b'obsolete distribution copy')
workspace=Path('/home/user/.companions/workspace');workspace.mkdir(parents=True)
(workspace/'keep.txt').write_text('retained user state')
source=Path('/tmp/distribution');source.mkdir()
shutil.copy('/usr/bin/true',source/'companion-agent')
(source/'install-desktop.sh').write_text('set -eu\ntest ! -f /tmp/fail-install\nprintf "1\\n" > /opt/companions/desktop-boundary.version\n')
archive=Path('/tmp/source.tar.gz')
with tarfile.open(archive,'w:gz') as output:
 for path in source.iterdir():output.add(path,arcname=path.name)
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
directory=Path('/tmp/companions-'+digest[:16]);directory.mkdir()
shutil.copy(archive,directory/'agent.tar.gz')
command=Path('/installation.sh').read_text().replace('0'*64,digest).replace('/tmp/companions-'+'0'*16,str(directory))
def install():return S.run(['sh','-c',command],capture_output=True,text=True,timeout=10)
# A service that remains active is a hard stop before replacing any bytes.
Path('/tmp/active').touch()
assert install().returncode!=0
assert (old/'companion-agent').read_bytes()==Path('/usr/bin/sleep').read_bytes()
Path('/tmp/active').unlink()
# A real process maps the old executable. Atomic exchange must still succeed,
# without ETXTBSY, even if an unrelated reader survives the simulated unit stop.
reader=S.Popen([str(old/'companion-agent'),'60'])
try:
 Path('/tmp/fail-install').touch()
 assert install().returncode!=0
 assert legacy.exists(), 'cleanup must wait for confirmed installation'
 Path('/tmp/fail-install').unlink()
 result=install();assert result.returncode==0,result.stderr
 assert reader.poll() is None
 assert (old/'companion-agent').read_bytes()==Path('/usr/bin/true').read_bytes()
 assert not legacy.exists()
 assert not list(Path('/opt').glob('.companions-build-*'))
 assert (workspace/'keep.txt').read_text()=='retained user state'
 result=install();assert result.returncode==0,result.stderr
 assert not legacy.exists() and (workspace/'keep.txt').read_text()=='retained user state'
 assert 'stop companions-agent-proxy.socket companions-agent-proxy.service companions-agent.service companions-desktop.service' in Path('/tmp/unit-calls').read_text()
 print('PASS active-unit refusal, mapped executable replacement, interrupted install retry, idempotent cleanup, retained state')
finally:
 reader.terminate();reader.wait(timeout=5)
