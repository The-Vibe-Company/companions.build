#!/usr/bin/env python3
"""Git post-checkout hook: seed Herdr worktrees with the primary checkout's .env."""
import os
from pathlib import Path
import subprocess


def git(*args):
    return subprocess.check_output(['git', *args], text=True, stderr=subprocess.DEVNULL).strip()


def main():
    if os.environ.get('HERDR_ENV') != '1':
        return
    root = Path(git('rev-parse', '--show-toplevel'))
    primary = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir')).parent
    source, destination = primary / '.env', root / '.env'
    if root.resolve() == primary.resolve() or not source.is_file() or destination.exists():
        return
    if subprocess.run(['git', 'check-ignore', '-q', '--', '.env']).returncode != 0:
        raise RuntimeError('Refusing to copy .env: it must be ignored by Git in this worktree')
    try:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return
    with os.fdopen(descriptor, 'wb') as target:
        target.write(source.read_bytes())
    print('Herdr: copied main .env into this worktree (private, Git-ignored).')


if __name__ == '__main__':
    main()
