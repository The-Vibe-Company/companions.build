"""Real ownership/masking proof; only systemd's user-bus responses are fixtures."""
import os
from pathlib import Path
import pwd
import socket
import subprocess as S

assert os.getuid()==0
S.run(['useradd','--uid','1000','--create-home','user'],check=True)
S.run(['useradd','--system','--no-create-home','companions-agent'],check=True)
agent=pwd.getpwnam('companions-agent')
Path('/etc/companions-desktop.env').write_text('DESKTOP_STATE_DIR=/var/lib/companions-desktop/00000000-0000-4000-8000-000000000001\n')
unit_dir=Path('/home/user/.config/systemd/user');unit_dir.mkdir(parents=True)
unit=unit_dir/'companions-agent.service';unit.write_text('old daemon')
wants=unit_dir/'default.target.wants';wants.mkdir();(wants/unit.name).symlink_to('../'+unit.name)
bus_path=Path('/run/user/1000/bus');bus_path.parent.mkdir(parents=True)
bus=socket.socket(socket.AF_UNIX);bus.bind(str(bus_path))
Path('/usr/local/bin/systemctl').write_text('''#!/bin/sh
if [ "$1" = --user ]; then
 [ "$(id -u)" = 1000 ] || exit 90
 [ "$XDG_RUNTIME_DIR" = /run/user/1000 ] || exit 91
 [ "$DBUS_SESSION_BUS_ADDRESS" = unix:path=/run/user/1000/bus ] || exit 92
 case "$2" in
 daemon-reload) exit 0;;
 stop) [ ! -f /tmp/deny-stop ] || exit 1; exit 0;;
 is-active) if [ -f /tmp/deny-stop ]; then echo active; else echo inactive; fi;exit 3;;
 esac
fi
echo inactive;exit 3
''');os.chmod('/usr/local/bin/systemctl',0o755)
state=Path('/home/user/.companions');(state/'pi'/'sessions').mkdir(parents=True)
(state/'workspace').mkdir();(state/'control.sqlite').write_bytes(b'unchanged SQLite fixture')
(state/'pi'/'sessions'/'history.jsonl').write_text('retained history')
for path in [state,*state.rglob('*')]:os.chown(path,1000,1000)
os.chown(state,agent.pw_uid,agent.pw_gid) # The exact mixed ownership seen on V6.
def retire():return S.run(['python3','/retire-legacy.py',str(state)],capture_output=True,text=True,timeout=10)
Path('/tmp/deny-stop').touch()
result=retire();assert result.returncode!=0 and 'LEGACY_SERVICE_STOP_FAILED' in result.stderr
assert not list(Path('/var/lib/companions-runtime-migrations').glob('*ownership*'))
assert (state/'control.sqlite').stat().st_uid==1000
Path('/tmp/deny-stop').unlink()
result=retire();assert result.returncode==0,result.stderr
assert unit.is_symlink() and os.readlink(unit)=='/dev/null'
assert not (wants/unit.name).is_symlink()
assert all(path.lstat().st_uid==agent.pw_uid for path in [state,*state.rglob('*')])
assert (state/'control.sqlite').read_bytes()==b'unchanged SQLite fixture'
assert (state/'pi'/'sessions'/'history.jsonl').read_text()=='retained history'
# Later starts must not invoke recursive chown again.
Path('/usr/local/bin/chown').write_text('#!/bin/sh\nexit 88\n');os.chmod('/usr/local/bin/chown',0o755)
result=retire();assert result.returncode==0,result.stderr
Path('/usr/local/bin/chown').unlink()
os.chown(state/'control.sqlite',1000,1000)
result=retire();assert result.returncode==0,result.stderr
assert (state/'control.sqlite').stat().st_uid==agent.pw_uid
# A later unmask invalidates both shortcuts and must migrate once again.
unit.unlink();unit.write_text('old daemon reintroduced');Path('/tmp/deny-stop').touch()
result=retire();assert result.returncode!=0 and 'LEGACY_SERVICE_STOP_FAILED' in result.stderr
Path('/tmp/deny-stop').unlink();bus.close();bus_path.unlink()
result=retire();assert result.returncode==0,result.stderr
assert os.readlink(unit)=='/dev/null'
# Installation retires without a state argument. It must invalidate ownership
# checkpoints before a later launch, even when only a deeply nested file changed.
unit.unlink();unit.write_text('legacy daemon reintroduced again')
nested=state/'pi'/'sessions'/'new-history.jsonl'
nested.write_text('retained legacy append');os.chown(nested,1000,1000)
result=S.run(['python3','/retire-legacy.py'],capture_output=True,text=True,timeout=10)
assert result.returncode==0,result.stderr
assert not list(Path('/var/lib/companions-runtime-migrations').glob('*-ownership-v1'))
assert nested.stat().st_uid==1000
result=retire();assert result.returncode==0,result.stderr
assert nested.stat().st_uid==agent.pw_uid and nested.read_text()=='retained legacy append'
# A fresh clone has a different identity even when it copied a valid checkpoint
# and all entry-point UIDs look correct. Its nested state must still be migrated.
os.chown(nested,1000,1000)
Path('/etc/companions-desktop.env').write_text('DESKTOP_STATE_DIR=/var/lib/companions-desktop/00000000-0000-4000-8000-000000000002\n')
assert all(path.lstat().st_uid==agent.pw_uid for path in [state,*state.iterdir()])
result=retire();assert result.returncode==0,result.stderr
assert nested.stat().st_uid==agent.pw_uid and nested.read_text()=='retained legacy append'
# Provider-style reset on a later resume: same identity/checkpoint, changed UIDs.
for path in [state,*state.rglob('*')]:os.chown(path,1000,1000)
result=retire();assert result.returncode==0,result.stderr
assert all(path.lstat().st_uid==agent.pw_uid for path in [state,*state.rglob('*')])
Path('/usr/local/bin/chown').write_text('#!/bin/sh\nexit 88\n');os.chmod('/usr/local/bin/chown',0o755)
result=retire();assert result.returncode==0,result.stderr
print('PASS legacy retirement, preserved histories, no repeated chown, reintroduction migration, cloned checkpoint identity, provider ownership reset on resume')
