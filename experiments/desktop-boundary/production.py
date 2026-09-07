"""Real compiled Pi daemon + production GUI broker + production headless launcher, local Linux only."""
import ctypes as C
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess as S
import threading
import time
import urllib.request
import uuid

def run(*args): S.run(args,check=True,stdout=S.DEVNULL,stderr=S.DEVNULL)
def until(check,timeout=20):
    end=time.monotonic()+timeout
    while True:
        value=check()
        if value: return value
        if time.monotonic()>end: raise AssertionError('production proof timed out')
        time.sleep(.05)

run('useradd','--uid','1000','--create-home','user')
run('groupadd','--system','companions-desktop-client')
run('useradd','--system','--no-create-home','--groups','companions-desktop-client','companions-agent')
# This fixture has no systemd user manager; GUI/Pi processes below are real.
Path('/usr/local/bin/systemctl').write_text('#!/bin/sh\n[ "$1" = is-active ] || exit 91\necho inactive\nexit 3\n')
os.chmod('/usr/local/bin/systemctl',0o755)
Path('/etc/companions-desktop.env').write_text('DESKTOP_STATE_DIR=/var/lib/companions-desktop/00000000-0000-4000-8000-000000000001\n')
Path('/home/user/browser-secret').write_text('desktop-private')
for path in ['/run/companions-desktop','/run/companions-desktop-admin','/var/lib/companions-desktop']:
    Path(path).mkdir(parents=True,exist_ok=True); os.chown(path,1000,1000)
for name in ['capture','quiesce']:
    target='/usr/local/bin/companions-desktop-'+name
    shutil.copy('/opt/companions/desktop-'+name+'.py',target); os.chmod(target,0o755)
Path('/proof-outer-namespaces.json').write_text(json.dumps({name:os.readlink('/proc/self/ns/'+name) for name in ['pid','mnt','net']}))
run('ip','netns','add','fixture'); run('ip','link','add','fixture','type','veth','peer','name','fixture-peer')
run('ip','link','set','fixture-peer','netns','fixture'); run('ip','addr','add','10.210.0.1/24','dev','fixture');run('ip','link','set','fixture','up')
run('ip','-n','fixture','addr','add','10.210.0.2/24','dev','fixture-peer');run('ip','-n','fixture','link','set','fixture-peer','up')
run('ip','-n','fixture','link','set','lo','up');run('ip','-n','fixture','route','add','default','via','10.210.0.1')
server="from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(b'HEADLESS_NETWORK_OK')\n def log_message(self,*a):pass\nHTTPServer(('0.0.0.0',9020),H).serve_forever()"
S.Popen(['ip','netns','exec','fixture','python3','-c',server])
def network_ready():
    try: return urllib.request.urlopen('http://10.210.0.2:9020',timeout=.1).read()==b'HEADLESS_NETWORK_OK'
    except OSError: return False
until(network_ready)
cdp=socket.socket();cdp.bind(('0.0.0.0',9222));cdp.listen()
S.Popen(['Xvfb',':0','-screen','0','640x480x24','-ac','-nolisten','tcp'],stderr=S.DEVNULL)
until(lambda:Path('/tmp/.X11-unix/X0').exists())
x=C.CDLL('libX11.so.6');xt=C.CDLL('libXtst.so.6');x.XInitThreads();x.XOpenDisplay.restype=C.c_void_p
d=x.XOpenDisplay(b':0');assert d
for name,args,result in [('XDefaultRootWindow',[C.c_void_p],C.c_ulong),('XCreateSimpleWindow',[C.c_void_p,C.c_ulong,C.c_int,C.c_int,C.c_uint,C.c_uint,C.c_uint,C.c_ulong,C.c_ulong],C.c_ulong),('XSelectInput',[C.c_void_p,C.c_ulong,C.c_long],C.c_int),('XMapWindow',[C.c_void_p,C.c_ulong],C.c_int),('XSetInputFocus',[C.c_void_p,C.c_ulong,C.c_int,C.c_ulong],C.c_int),('XSync',[C.c_void_p,C.c_int],C.c_int),('XPending',[C.c_void_p],C.c_int),('XNextEvent',[C.c_void_p,C.c_void_p],C.c_int),('XKeysymToKeycode',[C.c_void_p,C.c_ulong],C.c_uint)]:
    getattr(x,name).argtypes=args;getattr(x,name).restype=result
xt.XTestFakeKeyEvent.argtypes=[C.c_void_p,C.c_uint,C.c_int,C.c_ulong]
window=x.XCreateSimpleWindow(d,x.XDefaultRootWindow(d),0,0,400,200,0,0,0);x.XSelectInput(d,window,1);x.XMapWindow(d,window);x.XSetInputFocus(d,window,1,0);x.XSync(d,0)
class Key(C.Structure):
    _fields_=[('type',C.c_int),('serial',C.c_ulong),('send_event',C.c_int),('display',C.c_void_p),('window',C.c_ulong),('root',C.c_ulong),('subwindow',C.c_ulong),('time',C.c_ulong),('x',C.c_int),('y',C.c_int),('x_root',C.c_int),('y_root',C.c_int),('state',C.c_uint),('keycode',C.c_uint),('same_screen',C.c_int)]
agent_key=x.XKeysymToKeycode(d,ord('a'));human_key=x.XKeysymToKeycode(d,ord('h'));counts={'agent':0,'human':0}
def events():
    while True:
        if x.XPending(d):
            raw=C.create_string_buffer(192);x.XNextEvent(d,raw);key=C.cast(raw,C.POINTER(Key)).contents
            if key.type==2:
                if key.keycode==agent_key:counts['agent']+=1
                if key.keycode==human_key:counts['human']+=1
        else:time.sleep(.005)
threading.Thread(target=events,daemon=True).start()
broker=S.Popen(['setpriv','--reuid=1000','--regid=companions-desktop-client','--clear-groups','/opt/companions/companion-agent','--desktop-broker'],env={**os.environ,'DISPLAY':':0'},stdout=S.DEVNULL)
until(lambda:Path('/run/companions-desktop-admin/control.sock').exists())
def desktop(generation,taken):
    # Exercise the exact executor bridge, including its read socket, rather than a fixture-only PUT.
    current=json.loads(S.check_output(['python3','/opt/companions/desktop-state.py']))
    assert current['generation']<=generation
    body=json.loads(S.check_output(['python3','/opt/companions/desktop-state.py',str(generation),'true' if taken else 'false']))
    assert body['confirmed'] and body['generation']==generation and body['taken']==taken;return body
desktop(0,False)
token=str(uuid.uuid4());state='/home/user/.companions'
other=Path('/var/lib/companions-agent/00000000-0000-4000-8000-000000000099');other.mkdir(parents=True)
(other/'parent-private-history').write_text('hidden source parent')
# Recover a crash between netns creation and moving its veth peer.
S.run(['ip','netns','add','companions-agent'],check=True)
S.run(['ip','link','add','cmp-agent','type','veth','peer','name','cmp-peer'],check=True)
daemon=S.Popen(['python3','/opt/companions/launch-headless.py'],env={**os.environ,'AGENT_STATE_DIR':state,'AGENT_TOKEN':token,'AGENT_TEST_MODE':'1','PORT':'8787'},stdout=S.DEVNULL)
def agent(path,body=None):
    request=urllib.request.Request('http://100.127.250.2:8787'+path,data=None if body is None else json.dumps(body).encode(),method='GET' if body is None else 'PUT',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    return json.loads(urllib.request.urlopen(request,timeout=10).read())
def ready():
    try:return agent('/health')['desktopBoundaryVersion']==1
    except OSError:return False
until(ready)
# A duplicate launcher must not rebuild an in-use namespace or disturb the first daemon.
duplicate=S.run(['python3','/opt/companions/launch-headless.py'],env={**os.environ,'AGENT_STATE_DIR':state},capture_output=True,timeout=5)
assert duplicate.returncode!=0 and b'HEADLESS_PREVIOUS_INVOCATION_ALIVE' in duplicate.stderr
assert ready()
def start(content,lane='main'):
    identity=str(uuid.uuid4());agent('/runs/'+identity,{'content':content,'instructions':'','lane':lane});return identity
def finished(identity):
    value=agent('/runs/'+identity)
    if value['status'] in ['failed','interrupted','cancelled']:raise AssertionError('Pi run failed: '+value['status'])
    return value if value['status']=='succeeded' else None
network=start('desktop-network-fixture','background');workspace=Path('/var/lib/companions-agent/00000000-0000-4000-8000-000000000001/workspace')
until(lambda:(workspace/'direct-bypass-denied').exists())
typing=start('desktop-type-fixture');until(lambda:counts['agent']>=3)
desktop(1,True);until(lambda:finished(typing));time.sleep(.1)
before=counts.copy();network_before=int((workspace/'network-counter').read_text())
note=start('write-note');until(lambda:finished(note))
assert (workspace/'note.txt').read_text()=='written by real Pi tools\n'
import pwd
assert (workspace/'note.txt').stat().st_uid==pwd.getpwnam('companions-agent').pw_uid
assert not (Path(state)/'workspace'/'note.txt').exists()
for _ in range(10):
    xt.XTestFakeKeyEvent(d,human_key,1,0);xt.XTestFakeKeyEvent(d,human_key,0,0);x.XSync(d,0);time.sleep(.1)
assert counts['agent']==before['agent'];assert counts['human']==before['human']+10
assert int((workspace/'network-counter').read_text())>network_before+5
desktop(2,False);resumed=start('desktop-key-fixture');until(lambda:finished(resumed));assert counts['agent']>before['agent']
until(lambda:finished(network))
print(json.dumps({'status':'passed','realPiTools':True,'guiPaused':True,'chatDuringTakeover':True,'headlessNetworkDuringTakeover':True,'humanGuiWorks':True,'directBypassDenied':True,'freshCaptureAndResume':True}))
