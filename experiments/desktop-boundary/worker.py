import ctypes
import json
import os
import socket
import time
import urllib.request

def connect(address, family=socket.AF_UNIX):
    with socket.socket(family) as client:
        client.settimeout(.3)
        try:
            client.connect(address)
            return True
        except OSError:
            return False

assert os.getuid() == 1100
assert not connect('/tmp/.X11-unix/X0')
assert not connect('\0/tmp/.X11-unix/X0')
assert not connect(('127.0.0.1', 9222), socket.AF_INET)
assert not connect(('10.209.0.1', 9222), socket.AF_INET)
assert not connect(('::1', 9222), socket.AF_INET6)
assert open('/proc/sys/net/ipv6/conf/all/disable_ipv6').read().strip() == '1'
assert all(os.readlink('/proc/self/ns/'+name) != outer for name,outer in json.load(open('/state/outer-namespaces.json')).items())
assert not any(b'/proof/prove.py' in open('/proc/'+pid+'/cmdline','rb').read() for pid in os.listdir('/proc') if pid.isdigit())
assert not os.path.exists('/home/user/browser-secret')
assert not os.path.exists('/admin/control.sock')
assert not os.path.exists('/proc/1/root/home/user/browser-secret')
assert not os.path.exists('/run/docker.sock')
assert not os.path.exists('/dev/uinput')
try:
    os.setuid(0)
    raise AssertionError('root escalation succeeded')
except PermissionError:
    pass
assert urllib.request.urlopen('http://10.210.0.2:9020', timeout=3).read() == b'HEADLESS_NETWORK_OK'
with open('/state/bypass.json', 'w') as file:
    json.dump({'x11PathDenied': True, 'x11AbstractDenied': True, 'cdpLoopbackDenied': True,
        'cdpHostDenied': True, 'browserProfileHidden': True, 'adminHidden': True,
        'procEscapeDenied': True, 'devicesDenied': True, 'noRoot': True, 'headlessNetworkWorks': True}, file)

for count in range(200):
    assert urllib.request.urlopen('http://10.210.0.2:9020', timeout=3).read() == b'HEADLESS_NETWORK_OK'
    with open('/state/network', 'w') as file:
        file.write(str(count))
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(2)
        client.connect('/run/companions-desktop/agent.sock')
        client.sendall(b'key\n')
        result = client.recv(100)
        assert result in (b'done', b'paused')
    with open('/state/headless', 'w') as file:
        file.write(str(count))
    time.sleep(.05)
