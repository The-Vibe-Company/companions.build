"""Executed by the real Pi bash tool inside the production headless namespace."""
import json
import os
from pathlib import Path
import socket
import time
import urllib.request

def denied(address,family=socket.AF_UNIX):
    with socket.socket(family) as connection:
        connection.settimeout(.2)
        try: connection.connect(address)
        except OSError: return True
        return False

assert os.getuid()!=0 and os.getuid()!=1000
assert denied('/tmp/.X11-unix/X0') and denied('\0/tmp/.X11-unix/X0')
assert denied(('127.0.0.1',9222),socket.AF_INET) and denied(('100.127.250.1',9222),socket.AF_INET)
assert denied(('::1',9222),socket.AF_INET6)
assert Path('/proc/sys/net/ipv6/conf/all/disable_ipv6').read_text().strip()=='1'
for prefix in ['', '/etc/..', '/usr/..', '/proc/self/root']:
    assert not Path(prefix+'/home/user/browser-secret').exists()
    assert not Path(prefix+'/var/lib/companions-agent').exists()
    assert denied(prefix+'/tmp/.X11-unix/X0')
    assert not Path(prefix+'/run/companions-desktop-admin/control.sock').exists()
assert Path('/etc/resolv.conf').read_text()==Path('/tmp/resolv.conf').read_text()
assert 'nameserver ' in Path('/etc/resolv.conf').read_text()
assert not Path('/run/companions-desktop-admin/control.sock').exists()
assert not Path('/dev/uinput').exists()
assert all(os.readlink('/proc/self/ns/'+name)!=outer for name,outer in json.loads(Path('/proof-outer-namespaces.json').read_text()).items())
try: os.setuid(0)
except PermissionError: pass
else: raise AssertionError('root escalation succeeded')
Path('direct-bypass-denied').write_text('verified')
for count in range(100):
    assert urllib.request.urlopen('http://10.210.0.2:9020',timeout=2).read()==b'HEADLESS_NETWORK_OK'
    temporary=Path('network-counter.tmp'); temporary.write_text(str(count)); temporary.replace('network-counter')
    time.sleep(.1)
