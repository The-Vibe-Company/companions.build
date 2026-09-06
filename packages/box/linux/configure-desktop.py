#!/usr/bin/python3
"""Select this Box's Companion identity before its isolated services start."""
import os
from pathlib import Path
import pwd
import subprocess
import sys
import uuid

if os.getuid() != 0 or len(sys.argv) != 2:
    raise SystemExit('DESKTOP_CONFIGURATION_REQUIRED')
identity = str(uuid.UUID(sys.argv[1]))
directory = Path('/var/lib/companions-desktop') / identity
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
user = pwd.getpwnam('user')
os.chown(directory, user.pw_uid, user.pw_gid)
content = 'DESKTOP_STATE_DIR=' + str(directory) + '\n'
target = Path('/etc/companions-desktop.env')
changed = not target.exists() or target.read_text() != content
if changed:
    target.write_text(content)
    target.chmod(0o600)
subprocess.run(['systemctl', 'restart' if changed else 'start', 'companions-desktop.service'], check=True)
