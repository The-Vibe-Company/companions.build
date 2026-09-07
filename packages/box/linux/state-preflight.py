#!/usr/bin/python3
"""Exercise real file creation and SQLite WAL under the daemon UID, before health exists."""
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import sys
import tempfile


def check_directory(root, uid):
    if root.resolve() != root or root.stat().st_uid != uid:
        raise RuntimeError()
    probe = Path(tempfile.mkdtemp(prefix='.storage-preflight-', dir=root))
    verify_probe(probe, uid)


def verify_probe(probe, uid):
    try:
        check_probe(probe, uid)
    finally:
        shutil.rmtree(probe)


def main():
    uid = pwd.getpwnam('companions-agent').pw_uid
    if os.getuid() != uid or len(sys.argv) not in [2, 3] or (len(sys.argv) == 3 and sys.argv[2] != '--root-only'):
        raise RuntimeError()
    root = Path(sys.argv[1])
    directories = [root]
    if len(sys.argv) == 2:
        directories += [root / relative for relative in ['workspace', 'sessions', 'pi', 'outbox', 'pi/skills', 'sessions/background', 'workspace/inbox']]
    for directory in directories:
        check_directory(directory, uid)


def check_probe(probe, uid):
    path = probe / 'write'
    path.write_bytes(b'first')
    path.write_bytes(b'second')
    path.rename(probe / 'renamed')
    if (probe / 'renamed').read_bytes() != b'second':
        raise RuntimeError()
    with sqlite3.connect(probe / 'journal.sqlite') as db:
        if db.execute('pragma journal_mode=wal').fetchone()[0] != 'wal':
            raise RuntimeError()
        db.execute('create table preflight(value text)')
        db.execute("insert into preflight values ('first')")
        db.commit()
        db.execute("update preflight set value='second'")
        db.commit()
        if db.execute('select value from preflight').fetchone()[0] != 'second':
            raise RuntimeError()
        if any(path.lstat().st_uid != uid for path in [probe, *probe.iterdir()]):
            raise RuntimeError()
    db.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('HEADLESS_STATE_PREFLIGHT_FAILED')
