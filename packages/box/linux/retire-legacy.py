#!/usr/bin/python3
"""Retire the exact old user unit before migrating persistent state to the headless UID."""
import hashlib
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys

if os.getuid()!=0 or len(sys.argv)>2:
    raise SystemExit('LEGACY_RETIREMENT_REQUIRED')
user=pwd.getpwnam('user')
agent=pwd.getpwnam('companions-agent')
unit_dir=Path('/home/user/.config/systemd/user')
for parent in [Path('/home/user/.config'),Path('/home/user/.config/systemd'),unit_dir]:
    if parent.is_symlink():raise SystemExit('UNSAFE_LEGACY_UNIT_DIRECTORY')
    if not parent.exists():
        parent.mkdir();os.chown(parent,user.pw_uid,user.pw_gid)
unit=unit_dir/'companions-agent.service'
wanted=unit_dir/'default.target.wants'/'companions-agent.service'
if wanted.parent.is_symlink():raise SystemExit('UNSAFE_LEGACY_UNIT_DIRECTORY')
checkpoints=Path('/var/lib/companions-runtime-migrations')
if checkpoints.is_symlink():raise SystemExit('UNSAFE_RUNTIME_MIGRATION_DIRECTORY')
checkpoints.mkdir(mode=0o700,parents=True,exist_ok=True)
os.chown(checkpoints,0,0);checkpoints.chmod(0o700)
retired=checkpoints/'legacy-user-unit-v1'
already_masked=unit.is_symlink() and os.readlink(unit)=='/dev/null'
needs_retirement=not retired.exists() or retired.read_text()!='masked and stopped\n' or not already_masked or wanted.is_symlink() or wanted.exists()
if needs_retirement:
    retired.unlink(missing_ok=True)
    # A reintroduced legacy invocation may have written nested files since the
    # previous migration. Invalidate every state checkpoint, including when the
    # installer retires the unit without a state argument; migrate after stop.
    for previous in checkpoints.iterdir():
        if re.fullmatch(r'[a-f0-9]{64}-ownership-v1',previous.name):
            previous.unlink()
    # Offline mask survives a stopped user manager and the next provider resume.
    # A successful best-effort bus call alone is not a durable retirement checkpoint.
    if wanted.is_symlink():wanted.unlink()
    elif wanted.exists():raise SystemExit('UNSAFE_LEGACY_WANTS_ENTRY')
    if not already_masked:
        temporary=unit_dir/('.companions-agent-mask-'+str(os.getpid()))
        temporary.symlink_to('/dev/null');os.replace(temporary,unit)
    bus=Path('/run/user')/str(user.pw_uid)/'bus'
    if bus.exists():
        if not stat.S_ISSOCK(bus.stat().st_mode):raise SystemExit('LEGACY_USER_BUS_INVALID')
        base=['setpriv','--reuid='+str(user.pw_uid),'--regid='+str(user.pw_gid),'--init-groups',
              'env','XDG_RUNTIME_DIR='+str(bus.parent),'DBUS_SESSION_BUS_ADDRESS=unix:path='+str(bus),
              'systemctl','--user']
        reload=subprocess.run(base+['daemon-reload'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        if reload.returncode:raise SystemExit('LEGACY_SERVICE_STOP_FAILED')
        subprocess.run(base+['stop','companions-agent.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        status=subprocess.run(base+['is-active','companions-agent.service'],capture_output=True,text=True,timeout=5)
        if status.stdout.strip() not in ['inactive','failed','unknown']:
            raise SystemExit('LEGACY_SERVICE_STOP_FAILED')
    else:
        status=subprocess.run(['systemctl','is-active','user@'+str(user.pw_uid)+'.service'],capture_output=True,text=True,timeout=5)
    if status.stdout.strip() not in ['inactive','failed','unknown']:
        raise SystemExit('LEGACY_SERVICE_STOP_UNCONFIRMED')
    retired.write_text('masked and stopped\n')

if len(sys.argv)==2:
    state=sys.argv[1]
    if not re.fullmatch(r'/home/user/\.companions(?:/agents/[a-f0-9-]{36})?',state):
        raise SystemExit('INVALID_STATE_DIRECTORY')
    directory=Path(state);directory.mkdir(parents=True,exist_ok=True)
    if directory.resolve()!=directory:raise SystemExit('UNSAFE_STATE_DIRECTORY')
    checkpoint=checkpoints/(hashlib.sha256(state.encode()).hexdigest()+'-ownership-v1')
    if not checkpoint.exists() or checkpoint.read_text()!=state+'\n':
        # The root directory owner alone cannot prove a previous recursive migration
        # completed. Write a root-owned checkpoint only after the entire subtree succeeds.
        subprocess.run(['chown','-R','--no-dereference','companions-agent:companions-agent',state],check=True)
        checkpoint.write_text(state+'\n')
    # Cheap checks of runtime entry points; no recursive scan on an ordinary wake.
    for path in [directory,*directory.iterdir()]:
        if path.lstat().st_uid!=agent.pw_uid:
            raise SystemExit('HEADLESS_STATE_OWNERSHIP_CHANGED')
