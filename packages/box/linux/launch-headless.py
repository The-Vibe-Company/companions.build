#!/usr/bin/python3
"""Root service entrypoint. Build-time installation only; no dependency work at agent wake."""
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess

def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if os.getuid() != 0:
    raise SystemExit('HEADLESS_ROOT_SETUP_REQUIRED')
state = os.environ.get('AGENT_STATE_DIR', '')
if not re.fullmatch(r'/home/user/\.companions(?:/agents/[a-f0-9-]{36})?', state):
    raise SystemExit('INVALID_STATE_DIRECTORY')
namespace = Path('/run/netns/companions-agent')
# A service restart owns these fixed product interfaces. Refuse to disturb a surviving
# invocation, then rebuild only its empty namespace so a partial previous setup recovers.
if namespace.exists():
    occupants = subprocess.check_output(['ip', 'netns', 'pids', 'companions-agent'], text=True).strip()
    if occupants:
        raise SystemExit('HEADLESS_PREVIOUS_INVOCATION_ALIVE')
    run('ip', 'netns', 'delete', 'companions-agent')
# Migrate only while no previous invocation can write. The physical directory is
# POSIX storage; the original logical path remains Pi's persistent identity.
migration = subprocess.run(['python3', '/opt/companions/state-directory.py', state], capture_output=True, text=True)
if migration.returncode:
    code = migration.stderr.strip()
    raise SystemExit(code if re.fullmatch(r'[A-Z_]{1,80}', code) else 'HEADLESS_STATE_MIGRATION_FAILED')
physical = migration.stdout.strip()
if not re.fullmatch(r'/var/lib/companions-agent/[a-f0-9-]{36}', physical):
    raise SystemExit('INVALID_PHYSICAL_STATE_DIRECTORY')
os.environ['AGENT_PHYSICAL_STATE_DIR'] = physical
for interface in ['cmp-agent', 'cmp-peer']:
    # netns deletion tears down its veth asynchronously. The device can disappear
    # between show and delete; only the confirmed postcondition decides success.
    subprocess.run(['ip', 'link', 'delete', interface], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    links = json.loads(subprocess.check_output(['ip', '-j', 'link', 'show'], text=True))
    if any(link.get('ifname') == interface for link in links):
        raise SystemExit('HEADLESS_INTERFACE_DELETE_FAILED')
run('ip', 'netns', 'add', 'companions-agent')
run('ip', 'link', 'add', 'cmp-agent', 'type', 'veth', 'peer', 'name', 'cmp-peer')
run('ip', 'link', 'set', 'cmp-peer', 'netns', 'companions-agent')
run('ip', 'addr', 'add', '100.127.250.1/30', 'dev', 'cmp-agent')
run('ip', 'link', 'set', 'cmp-agent', 'up')
run('ip', '-n', 'companions-agent', 'addr', 'add', '100.127.250.2/30', 'dev', 'cmp-peer')
run('ip', '-n', 'companions-agent', 'link', 'set', 'cmp-peer', 'up')
run('ip', '-n', 'companions-agent', 'link', 'set', 'lo', 'up')
run('ip', '-n', 'companions-agent', 'route', 'add', 'default', 'via', '100.127.250.1')
run('ip', 'netns', 'exec', 'companions-agent', 'unshare', '--mount', '--mount-proc', 'sysctl', '-qw', 'net.ipv6.conf.all.disable_ipv6=1')
if Path('/proc/sys/net/ipv4/ip_forward').read_text().strip()!='1':
    run('sysctl', '-qw', 'net.ipv4.ip_forward=1')

def rule(table, chain, *args):
    check = subprocess.run(['iptables', '-w', '-t', table, '-C', chain, *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if check.returncode:
        run('iptables', '-w', '-t', table, '-I', chain, '1', *args)

# A headless process cannot reach host GUI/CDP/DBus proxies through an alternate host address.
rule('filter', 'INPUT', '-i', 'cmp-agent', '-j', 'DROP')
rule('filter', 'INPUT', '-i', 'cmp-agent', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT')
rule('filter', 'FORWARD', '-i', 'cmp-agent', '-j', 'ACCEPT')
rule('filter', 'FORWARD', '-o', 'cmp-agent', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT')
rule('nat', 'POSTROUTING', '-s', '100.127.250.2/32', '-j', 'MASQUERADE')

resolvers = []
for source in ['/run/systemd/resolve/resolv.conf', '/etc/resolv.conf']:
    try:
        for line in Path(source).read_text().splitlines():
            if line.startswith('nameserver '):
                address = ipaddress.ip_address(line.split()[1])
                if address.version == 4 and not address.is_loopback:
                    resolvers.append(str(address))
    except (OSError, ValueError):
        pass
    if resolvers:
        break
Path('/run/companions-headless-resolv.conf').write_text(''.join('nameserver '+value+'\n' for value in (resolvers or ['1.1.1.1'])))
os.environ['DESKTOP_AGENT_SOCKET'] = '/run/companions-desktop/agent.sock'
os.environ['DESKTOP_BOUNDARY_VERSION'] = '1'
os.environ.pop('DISPLAY', None)
os.environ.pop('XAUTHORITY', None)
os.environ.pop('DBUS_SESSION_BUS_ADDRESS', None)
os.execvp('ip', ['ip', 'netns', 'exec', 'companions-agent', 'unshare', '--mount', '--pid', '--fork', '--mount-proc',
    '/bin/sh', '/opt/companions/headless-mounts.sh'])
