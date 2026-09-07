#!/usr/bin/python3
"""Copy legacy state once to POSIX storage; never overwrite an activated directory."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import uuid


def fail(code):
    raise SystemExit(code)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def manifest(root):
    entries = []
    for path in sorted([root, *root.rglob('*')]):
        info = path.lstat()
        relative = str(path.relative_to(root))
        mode = stat.S_IMODE(info.st_mode)
        if stat.S_ISLNK(info.st_mode):
            value = ['link', os.readlink(path)]
        elif stat.S_ISDIR(info.st_mode):
            value = ['directory']
        elif stat.S_ISREG(info.st_mode):
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            value = ['file', info.st_size, digest.hexdigest()]
        else:
            fail('STATE_MIGRATION_UNSUPPORTED_ENTRY')
        entries.append([relative, mode, value])
    return hashlib.sha256(json.dumps(entries, separators=(',', ':')).encode()).hexdigest()


def main():
    if os.getuid() != 0 or len(sys.argv) != 2:
        fail('STATE_MIGRATION_ROOT_REQUIRED')
    logical = Path(sys.argv[1])
    identity_file = Path('/etc/companions-desktop.env')
    identity_match = re.fullmatch(r'DESKTOP_STATE_DIR=/var/lib/companions-desktop/([a-f0-9-]{36})\n?', identity_file.read_text())
    if not identity_match:
        fail('DESKTOP_IDENTITY_REQUIRED')
    identity = str(uuid.UUID(identity_match.group(1)))
    if str(logical) not in ['/home/user/.companions', '/home/user/.companions/agents/' + identity]:
        fail('INVALID_STATE_DIRECTORY')
    if logical.resolve() != logical:
        fail('UNSAFE_STATE_DIRECTORY')
    if Path('/run/netns/companions-agent').exists():
        if subprocess.check_output(['ip', 'netns', 'pids', 'companions-agent'], text=True).strip():
            fail('HEADLESS_PREVIOUS_INVOCATION_ALIVE')
    result = subprocess.run(['python3', '/opt/companions/retire-legacy.py'], capture_output=True, text=True, timeout=75)
    if result.returncode:
        code = result.stderr.strip()
        fail(code if re.fullmatch(r'[A-Z_]{1,80}', code) else 'LEGACY_RETIREMENT_FAILED')
    agent = pwd.getpwnam('companions-agent')
    parent = Path('/var/lib/companions-agent')
    if parent.resolve() != parent:
        fail('UNSAFE_PHYSICAL_STATE_DIRECTORY')
    parent.mkdir(mode=0o755, exist_ok=True)
    os.chown(parent, 0, 0)
    parent.chmod(0o755)
    target = parent / identity
    staging = parent / ('.copy-' + identity)
    checkpoint = Path('/var/lib/companions-runtime-migrations') / ('state-' + identity + '.json')
    expected = {'version': 1, 'identity': identity, 'logical': str(logical), 'uid': agent.pw_uid}

    def save(status, digest=None):
        record = {**expected, 'status': status, 'digest': digest}
        temporary = checkpoint.with_suffix('.tmp')
        with temporary.open('w') as stream:
            json.dump(record, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, checkpoint)
        sync_directory(checkpoint.parent)

    lock = checkpoint.with_suffix('.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    record = json.loads(checkpoint.read_text()) if checkpoint.exists() else None
    if record and any(record.get(key) != value for key, value in expected.items()):
        fail('STATE_MIGRATION_IDENTITY_MISMATCH')
    if target.is_symlink() or staging.is_symlink():
        fail('UNSAFE_PHYSICAL_STATE_DIRECTORY')
    if record and record['status'] == 'committed':
        if not target.is_dir():
            fail('STATE_MIGRATION_TARGET_MISSING')
        # The legacy home tree is a retained backup, never a subsequent source.
        print(target)
        return
    if target.exists():
        # Rename is atomic; a crash between rename and final checkpoint is safe
        # only when this exact verified copy is present. No daemon started yet.
        if not record or record['status'] != 'verified' or manifest(target) != record['digest']:
            fail('STATE_MIGRATION_TARGET_UNCONFIRMED')
    else:
        save('copying')
        if staging.exists():
            shutil.rmtree(staging)  # Only our unpublished, identity-specific copy.
        if logical.exists():
            before = manifest(logical)
            shutil.copytree(logical, staging, symlinks=True)
            if manifest(logical) != before or manifest(staging) != before:
                fail('STATE_MIGRATION_COPY_MISMATCH')
        else:
            # A new child has no legacy subtree: never import the parent history.
            staging.mkdir(mode=0o700)
        for path in [staging, *staging.rglob('*')]:
            os.chown(path, agent.pw_uid, agent.pw_gid, follow_symlinks=False)
            if path.is_file() and not path.is_symlink():
                with path.open('rb') as stream:
                    os.fsync(stream.fileno())
        staging.chmod(0o700)
        for path in reversed([staging, *staging.rglob('*')]):
            if path.is_dir() and not path.is_symlink():
                sync_directory(path)
        save('verified', manifest(staging))
        os.rename(staging, target)
        sync_directory(parent)
    result = subprocess.run(['setpriv', '--reuid=' + str(agent.pw_uid), '--regid=' + str(agent.pw_gid), '--init-groups',
                             'python3', '/opt/companions/state-preflight.py', str(target)], capture_output=True)
    if result.returncode:
        fail('HEADLESS_STATE_PREFLIGHT_FAILED')
    save('committed')
    print(target)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        fail('HEADLESS_STATE_MIGRATION_FAILED')
