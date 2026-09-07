"""Source identity shared by validation runners and development status commands."""
import hashlib
import os
from pathlib import Path
import subprocess


def source_evidence(root: Path):
    """Identify committed and dirty content without copying source into artifacts."""
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    status = subprocess.check_output(["git", "status", "--porcelain=v1", "-z"], cwd=root)
    digest = hashlib.sha256()
    digest.update(commit.encode())
    digest.update(b"\0")
    digest.update(subprocess.check_output(["git", "diff", "--binary", "HEAD"], cwd=root))
    untracked = subprocess.check_output(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=root
    ).split(b"\0")
    for raw_path in sorted(path for path in untracked if path):
        digest.update(raw_path)
        digest.update(b"\0")
        path = root / os.fsdecode(raw_path)
        if path.is_symlink():
            digest.update(os.fsencode(os.readlink(path)))
        elif path.is_file():
            digest.update(path.read_bytes())
    return {"commit": commit, "dirty": bool(status), "fingerprint": digest.hexdigest()}
