"""Exercise the real launcher setup repeatedly; only final exec is replaced, no Box calls."""
import os
import runpy
from pathlib import Path
import subprocess as S

assert os.getuid()==0
S.run(['useradd','--uid','1000','--create-home','user'],check=True)
Path('/usr/local/bin/systemctl').write_text('#!/bin/sh\necho inactive\nexit 3\n')
os.chmod('/usr/local/bin/systemctl',0o755)
S.run(['useradd','--system','--no-create-home','companions-agent'],check=True)
os.environ['AGENT_STATE_DIR']='/home/user/.companions'
os.execvp=lambda *_:None
for iteration in range(100):
    runpy.run_path('/launcher.py',run_name='__main__')
# A real failed deletion leaving an orphan veth must remain a hard failure.
S.run(['ip','netns','delete','companions-agent'],check=True)
S.run(['ip','link','delete','cmp-agent'],capture_output=True)
S.run(['ip','link','add','cmp-agent','type','veth','peer','name','cmp-peer'],check=True)
original=S.run
def denied_delete(args,*rest,**kwargs):
    if list(args[:3])==['ip','link','delete']:
        return S.CompletedProcess(args,1)
    return original(args,*rest,**kwargs)
S.run=denied_delete
try:
    runpy.run_path('/launcher.py',run_name='__main__')
    raise AssertionError('existing interface silently accepted')
except SystemExit as error:
    assert str(error)=='HEADLESS_INTERFACE_DELETE_FAILED'
finally:S.run=original
print('PASS 100 real namespace restarts; persistent interface deletion failure denied')
