"""Actual Linux copy/WAL/ownership; fault injection only at atomic migration checkpoints."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import sqlite3
import subprocess as S
import sys

S.run(['useradd','--uid','1000','--create-home','user'],check=True)
S.run(['useradd','--system','--no-create-home','companions-agent'],check=True)
agent=pwd.getpwnam('companions-agent')
Path('/usr/local/bin/systemctl').write_text('#!/bin/sh\necho inactive\nexit 3\n');os.chmod('/usr/local/bin/systemctl',0o755)
logical=Path('/home/user/.companions');(logical/'pi'/'sessions').mkdir(parents=True)
(logical/'pi'/'sessions'/'history.jsonl').write_bytes(b'preserved history\n')
(logical/'workspace').mkdir();(logical/'workspace'/'relative-link').symlink_to('../pi/sessions/history.jsonl')
with sqlite3.connect(logical/'runs.sqlite') as db:
    db.execute('create table runs(id text)');db.execute("insert into runs values ('accepted-never-replay')");db.commit()
for path in [logical,*logical.rglob('*')]:os.chown(path,1000,1000,follow_symlinks=False)
identity='00000000-0000-4000-8000-000000000001'
def configure(value):
    Path('/etc/companions-desktop.env').write_text('DESKTOP_STATE_DIR=/var/lib/companions-desktop/'+value+'\n')
def migrate(value=logical):
    return S.run(['python3','/opt/companions/state-directory.py',str(value)],capture_output=True,text=True)
configure(identity)
result=migrate();assert result.returncode==0,result.stderr
physical=Path(result.stdout.strip());assert physical==Path('/var/lib/companions-agent')/identity
assert all(path.lstat().st_uid==agent.pw_uid for path in [physical,*physical.rglob('*')])
assert (physical/'pi/sessions/history.jsonl').read_bytes()==b'preserved history\n'
assert (physical/'workspace/relative-link').is_symlink()
with sqlite3.connect(physical/'runs.sqlite') as db:assert db.execute('select id from runs').fetchone()[0]=='accepted-never-replay'
assert (logical/'runs.sqlite').stat().st_uid==1000
# A legacy write after activation must never replace current physical state.
(physical/'workspace/new-result').write_text('new authoritative result')
(logical/'pi/sessions/history.jsonl').write_text('stale backup changed')
result=migrate();assert result.returncode==0,result.stderr
assert (physical/'pi/sessions/history.jsonl').read_bytes()==b'preserved history\n'
assert (physical/'workspace/new-result').read_text()=='new authoritative result'
# Crash precisely after rename, before final checkpoint: the verified copy is
# reconciled without copying the (now changed) backup again.
spec=importlib.util.spec_from_file_location('migration','/opt/companions/state-directory.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
second='00000000-0000-4000-8000-000000000002';configure(second)
original=module.os.rename
class Crash(Exception):pass
def rename_then_crash(source,target):
    original(source,target);raise Crash()
module.os.rename=rename_then_crash;sys.argv=['state-directory.py',str(logical)]
try:
    module.main();raise AssertionError('fault did not fire')
except Crash:pass
finally:module.os.rename=original
(logical/'pi/sessions/history.jsonl').write_text('changed after crash')
result=migrate();assert result.returncode==0,result.stderr
assert (Path(result.stdout.strip())/'pi/sessions/history.jsonl').read_text()=='stale backup changed'
# Ordinary wake never hashes all existing history or invokes recursive migration.
original_manifest=module.manifest
module.manifest=lambda _:(_ for _ in ()).throw(AssertionError('repeated history scan'))
module.main()
module.manifest=original_manifest
# A crash before rename leaves only unpublished staging. Retry may copy the
# preserved source again, and must not mistake that staging for active state.
fifth='00000000-0000-4000-8000-000000000005';configure(fifth)
def crash_before_rename(source,target):raise Crash()
module.os.rename=crash_before_rename
try:
    module.main();raise AssertionError('fault did not fire')
except Crash:pass
finally:module.os.rename=original
assert not (Path('/var/lib/companions-agent')/fifth).exists()
(logical/'workspace/latest').write_text('latest before activation')
result=migrate();assert result.returncode==0,result.stderr
assert (Path(result.stdout.strip())/'workspace/latest').read_text()=='latest before activation'
# A child identity must not read source parent physical state or its legacy root.
child='00000000-0000-4000-8000-000000000003';configure(child)
child_logical=logical/'agents'/child
result=migrate(child_logical);assert result.returncode==0,result.stderr
assert list(Path(result.stdout.strip()).iterdir())==[]
assert not child_logical.exists()
# Actual UID verifies both SQLite writes and refusal of wrongly owned new files.
preflight=['setpriv','--reuid='+str(agent.pw_uid),'--regid='+str(agent.pw_gid),'--init-groups','python3','/opt/companions/state-preflight.py',str(physical)]
assert S.run(preflight).returncode==0
os.chown(physical,1000,1000)
assert S.run(preflight,capture_output=True).returncode!=0
os.chown(physical,agent.pw_uid,agent.pw_gid)
assert S.run(preflight).returncode==0
# An unverified existing destination is never silently adopted or overwritten.
fourth='00000000-0000-4000-8000-000000000004';configure(fourth)
foreign=Path('/var/lib/companions-agent')/fourth;foreign.mkdir();(foreign/'keep').write_text('untouched')
result=migrate();assert result.returncode!=0 and 'STATE_MIGRATION_TARGET_UNCONFIRMED' in result.stderr
assert (foreign/'keep').read_text()=='untouched'
print('PASS preserved Pi history/SQLite/symlinks, immutable backup, WAL preflight, crash-after-rename recovery, no warm history scan, fresh child empty, unverified target refusal')
