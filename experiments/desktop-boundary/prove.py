"""Local Linux proof only. No Box credentials, model calls, or developer-host lifecycle commands."""
import ctypes as C
import json
import os
from pathlib import Path
import socket
import subprocess as S
import threading
import time

def command(*args):
    S.run(args, check=True, stdout=S.DEVNULL)

def until(check, timeout=10):
    end = time.monotonic() + timeout
    while not check():
        if time.monotonic() > end:
            raise AssertionError('proof timed out')
        time.sleep(.05)

for path in ['/state', '/broker', '/admin', '/home/user']:
    Path(path).mkdir(parents=True, exist_ok=True)
os.chown('/state', 1100, 1100)
Path('/home/user/browser-secret').write_text('not exposed to headless tools')
Path('/admin/control.sock').touch()

# Two private networks: runtime -> public-service fixture, never runtime -> desktop host.
command('ip', 'netns', 'add', 'headless')
command('ip', 'netns', 'add', 'fixture')
for name, net, subnet in [('agent', 'headless', '10.209.0'), ('fixture', 'fixture', '10.210.0')]:
    command('ip', 'link', 'add', name, 'type', 'veth', 'peer', 'name', name + '-peer')
    command('ip', 'link', 'set', name + '-peer', 'netns', net)
    command('ip', 'addr', 'add', subnet + '.1/24', 'dev', name)
    command('ip', 'link', 'set', name, 'up')
    command('ip', '-n', net, 'addr', 'add', subnet + '.2/24', 'dev', name + '-peer')
    command('ip', '-n', net, 'link', 'set', name + '-peer', 'up')
    command('ip', '-n', net, 'link', 'set', 'lo', 'up')
    command('ip', '-n', net, 'route', 'add', 'default', 'via', subnet + '.1')
command('ip', 'netns', 'exec', 'headless', 'unshare', '--mount', '--mount-proc', 'python3', '-c', "open('/proc/sys/net/ipv6/conf/all/disable_ipv6','w').write('1')")
if Path('/proc/sys/net/ipv4/ip_forward').read_text().strip() != '1':
    Path('/proc/sys/net/ipv4/ip_forward').write_text('1')
command('iptables', '-I', 'INPUT', '-i', 'agent', '-j', 'DROP')
server = "from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(b'HEADLESS_NETWORK_OK')\n def log_message(self,*a): pass\nHTTPServer(('0.0.0.0',9020),H).serve_forever()"
S.Popen(['ip', 'netns', 'exec', 'fixture', 'python3', '-c', server])
until(lambda: S.run(['ip','netns','exec','headless','python3','-c',"import socket;s=socket.create_connection(('10.210.0.2',9020),.1);s.close()"],stdout=S.DEVNULL,stderr=S.DEVNULL).returncode==0)
cdp = socket.socket(); cdp.bind(('0.0.0.0', 9222)); cdp.listen()
cdp6 = socket.socket(socket.AF_INET6); cdp6.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1); cdp6.bind(('::',9222)); cdp6.listen()
Path('/state/outer-namespaces.json').write_text(json.dumps({name:os.readlink('/proc/self/ns/'+name) for name in ['pid','mnt','net']}))

S.Popen(['Xvfb', ':0', '-screen', '0', '640x480x24', '-ac', '-nolisten', 'tcp'], stderr=S.DEVNULL)
until(lambda: Path('/tmp/.X11-unix/X0').exists())
os.environ['DISPLAY'] = ':0'
x = C.CDLL('libX11.so.6'); xt = C.CDLL('libXtst.so.6')
x.XInitThreads()
x.XOpenDisplay.restype = C.c_void_p
display = x.XOpenDisplay(b':0'); assert display
for name, args, result in [
    ('XDefaultRootWindow', [C.c_void_p], C.c_ulong),
    ('XCreateSimpleWindow', [C.c_void_p,C.c_ulong,C.c_int,C.c_int,C.c_uint,C.c_uint,C.c_uint,C.c_ulong,C.c_ulong], C.c_ulong),
    ('XSelectInput', [C.c_void_p,C.c_ulong,C.c_long], C.c_int),
    ('XMapWindow', [C.c_void_p,C.c_ulong], C.c_int),
    ('XSetInputFocus', [C.c_void_p,C.c_ulong,C.c_int,C.c_ulong], C.c_int),
    ('XSync', [C.c_void_p,C.c_int], C.c_int),
    ('XPending', [C.c_void_p], C.c_int),
    ('XNextEvent', [C.c_void_p,C.c_void_p], C.c_int),
    ('XKeysymToKeycode', [C.c_void_p,C.c_ulong], C.c_uint),
]:
    getattr(x,name).argtypes=args; getattr(x,name).restype=result
xt.XTestFakeKeyEvent.argtypes=[C.c_void_p,C.c_uint,C.c_int,C.c_ulong]
window=x.XCreateSimpleWindow(display,x.XDefaultRootWindow(display),0,0,400,200,0,0,0)
x.XSelectInput(display,window,1); x.XMapWindow(display,window)
x.XSetInputFocus(display,window,1,0); x.XSync(display,0)
agent_key=x.XKeysymToKeycode(display,ord('a')); human_key=x.XKeysymToKeycode(display,ord('h'))
counts={'agent':0,'human':0}; gate=threading.Lock(); taken=False
class KeyEvent(C.Structure):
    _fields_=[('type',C.c_int),('serial',C.c_ulong),('send_event',C.c_int),('display',C.c_void_p),('window',C.c_ulong),('root',C.c_ulong),('subwindow',C.c_ulong),('time',C.c_ulong),('x',C.c_int),('y',C.c_int),('x_root',C.c_int),('y_root',C.c_int),('state',C.c_uint),('keycode',C.c_uint),('same_screen',C.c_int)]
def inject(key):
    xt.XTestFakeKeyEvent(display,key,1,0); xt.XTestFakeKeyEvent(display,key,0,0); x.XSync(display,0)
def events():
    while True:
        if x.XPending(display):
            event=C.create_string_buffer(192); x.XNextEvent(display,event)
            key=C.cast(event,C.POINTER(KeyEvent)).contents
            if key.type==2:
                if key.keycode==agent_key: counts['agent']+=1
                if key.keycode==human_key: counts['human']+=1
        else: time.sleep(.005)
threading.Thread(target=events,daemon=True).start()
listener=socket.socket(socket.AF_UNIX); listener.bind('/broker/agent.sock'); os.chmod('/broker/agent.sock',0o666); listener.listen()
def broker():
    while True:
        client,_=listener.accept()
        with client:
            assert client.recv(100)==b'key\n'
            with gate:
                if taken: client.sendall(b'paused')
                else: inject(agent_key); client.sendall(b'done')
threading.Thread(target=broker,daemon=True).start()
worker=S.Popen(['ip','netns','exec','headless','unshare','--mount','--pid','--fork','--mount-proc','/bin/sh','/proof/headless.sh'])
until(lambda: counts['agent']>=3 or worker.poll() is not None)
assert worker.poll() is None, 'headless setup failed'
with gate:
    taken=True
# This fixture consumes the server events already acknowledged before taking its observation baseline.
time.sleep(.1)
before=counts.copy(); headless_before=int(Path('/state/headless').read_text()); network_before=int(Path('/state/network').read_text())
for _ in range(10):
    inject(human_key); time.sleep(.1)
assert counts['agent']==before['agent'], counts
assert counts['human']==before['human']+10, counts
assert int(Path('/state/headless').read_text())>headless_before+5
assert int(Path('/state/network').read_text())>network_before+5
with gate: taken=False
until(lambda: counts['agent']>before['agent'])
print(json.dumps({'status':'passed','guiPaused':True,'humanGuiWorks':True,'headlessContinues':True,'guiResumes':True,**json.loads(Path('/state/bypass.json').read_text())}))
