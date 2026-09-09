#!/usr/bin/python3
"""Crash-safe, runtime-only updater for an existing Companions Linux Box."""
from __future__ import annotations

import argparse
import ctypes
import errno
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
import tempfile
import time
import uuid


RUNTIME_FILES = ("companion-agent", "photon_rs_bg.wasm", "package.json", "runtime-release.json")
PAYLOAD_FILES = RUNTIME_FILES[:3]
DEFERRED = {"AGENT_NOT_RUNNING", "AGENT_BUSY", "UNSAFE_CGROUP", "EPHEMERAL_DATA_PRESENT",
            "UNKNOWN_EPHEMERAL_LAYOUT", "FREEZE_UNAVAILABLE"}
EXIT = {"succeeded": 0, "rolled_back": 0, "not_started": 0, "pending": 1, "deferred": 75, "failed": 1}
HEX = re.compile(r"[0-9a-f]{64}")
UNIT = "companions-agent.service"
PROXY_UNITS = ("companions-agent-proxy.socket", "companions-agent-proxy.service")


class UpdateError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail)
        self.code, self.detail = code, detail


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def release_digest(hashes: dict[str, str | None]) -> str:
    encoded = json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".journal-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


class LinuxSystem:
    def __init__(self, install: Path = Path("/opt/companions"), state: Path = Path("/var/lib/companions-runtime")):
        self.install, self.state = install, state

    def require_root(self) -> None:
        if os.geteuid() != 0:
            raise UpdateError("ROOT_REQUIRED")
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.state.is_symlink() or self.state.stat().st_uid != 0:
            raise UpdateError("UNSAFE_STATE_DIRECTORY")
        os.chmod(self.state, 0o700)

    def command(self, *arguments: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(arguments, text=True, capture_output=True, check=check)

    def service_property(self, name: str) -> str:
        result = self.command("systemctl", "show", UNIT, "--property", name, "--value", check=False)
        return result.stdout.strip() if result.returncode == 0 else ""

    def service_active(self) -> bool:
        return self.command("systemctl", "is-active", "--quiet", UNIT, check=False).returncode == 0

    def service_processes(self) -> list[tuple[int, str]]:
        cgroup = self.service_property("ControlGroup")
        if not cgroup or ".." in Path(cgroup).parts:
            raise UpdateError("UNSAFE_CGROUP")
        procs = Path("/sys/fs/cgroup") / cgroup.lstrip("/") / "cgroup.procs"
        try:
            pids = [int(value) for value in procs.read_text().split()]
        except (OSError, ValueError):
            raise UpdateError("UNSAFE_CGROUP")
        found = []
        for pid in pids:
            try:
                command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
            except OSError:
                raise UpdateError("AGENT_BUSY")
            found.append((pid, command))
        return found

    def preflight(self) -> None:
        if not self.service_active():
            raise UpdateError("AGENT_NOT_RUNNING")
        processes = self.service_processes()
        allowed = re.compile(
            r"^(?:/usr/bin/python3 /opt/companions/launch-headless\.py(?: |$)|"
            r"(?:/usr/sbin/|/usr/bin/)?ip netns exec companions-agent(?: |$)|"
            r"(?:/usr/bin/)?unshare --mount --pid --fork --mount-proc(?: |$)|"
            r"/bin/sh /opt/companions/headless-mounts\.sh(?: |$)|"
            r"/opt/companions/companion-agent(?: |$))")
        agent_processes = [command for _, command in processes if command.startswith("/opt/companions/companion-agent")]
        if not processes or len(agent_processes) != 1 or any(not allowed.match(command) for _, command in processes):
            raise UpdateError("AGENT_BUSY")
        daemon_pid = next(pid for pid, command in processes if command.startswith("/opt/companions/companion-agent"))
        root = Path(f"/proc/{daemon_pid}/root")
        try:
            if not root.exists():
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
            tmp_names = {entry.name for entry in (root / "tmp").iterdir()}
            fixed_tmp = {"agent-state", "desktop-agent", "resolv.conf"}
            brokers = {name for name in tmp_names - fixed_tmp if re.fullmatch(r"companions-git-credentials-[A-Za-z0-9]{6}", name)}
            if tmp_names - fixed_tmp - brokers:
                raise UpdateError("EPHEMERAL_DATA_PRESENT")
            self.validate_git_brokers(root, brokers)
            self.validate_persistent_mounts(root, daemon_pid)
            self.validate_run(root)
            self.validate_devices(root)
            for directory in ("var", "sys"):
                if any((root / directory).iterdir()):
                    raise UpdateError("EPHEMERAL_DATA_PRESENT")
        except UpdateError:
            raise
        except OSError:
            raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")

    def validate_persistent_mounts(self, root: Path, daemon_pid: int) -> None:
        try:
            environment = Path(f"/proc/{daemon_pid}/environ").read_bytes().split(b"\0")
            physical_value = next(value.split(b"=", 1)[1].decode() for value in environment
                                  if value.startswith(b"AGENT_PHYSICAL_STATE_DIR="))
            logical_value = next(value.split(b"=", 1)[1].decode() for value in environment
                                 if value.startswith(b"AGENT_STATE_DIR="))
            identity = re.fullmatch(r"DESKTOP_STATE_DIR=/var/lib/companions-desktop/([a-f0-9-]{36})\n?",
                                    Path("/etc/companions-desktop.env").read_text())
            valid_logical = {"/home/user/.companions", f"/home/user/.companions/agents/{identity.group(1)}"} if identity else set()
            if (not identity or physical_value != f"/var/lib/companions-agent/{identity.group(1)}" or
                    logical_value not in valid_logical):
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
            pairs = ((root / "tmp/agent-state", Path(physical_value)),
                     (root / logical_value.lstrip("/"), Path(physical_value)),
                     (root / "tmp/desktop-agent", Path("/run/companions-desktop")),
                     (root / "run/companions-desktop", Path("/run/companions-desktop")))
            for isolated, host in pairs:
                left, right = isolated.stat(), host.stat()
                if (left.st_dev, left.st_ino) != (right.st_dev, right.st_ino):
                    raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
            resolver = Path("/run/companions-headless-resolv.conf").read_bytes()
            if (root / "tmp/resolv.conf").read_bytes() != resolver:
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
            current = root / "home"
            parts = Path(logical_value).parts[2:]
            for part in parts:
                if {entry.name for entry in current.iterdir()} != {part}:
                    raise UpdateError("EPHEMERAL_DATA_PRESENT")
                current /= part
        except (OSError, StopIteration, UnicodeDecodeError):
            raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")

    def validate_run(self, root: Path) -> None:
        resolver_target = self.host_resolver_target()
        relative = None
        try:
            relative = resolver_target.relative_to("/run")
        except ValueError:
            pass
        allowed_top = {"companions-desktop", "mount"} | ({relative.parts[0]} if relative and relative.parts else set())
        run = root / "run"
        if {entry.name for entry in run.iterdir()} != allowed_top:
            raise UpdateError("EPHEMERAL_DATA_PRESENT")
        self.validate_mount_bookkeeping(run / "mount")
        if relative:
            current = run / relative.parts[0]
            if len(relative.parts) > 1 and not current.is_dir():
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
            for index, part in enumerate(relative.parts[1:], start=1):
                entries = {entry.name for entry in current.iterdir()}
                if entries != {part}:
                    raise UpdateError("EPHEMERAL_DATA_PRESENT")
                current /= part
                if index < len(relative.parts) - 1 and not current.is_dir():
                    raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
            if current.read_bytes() != self.resolver_bytes():
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")

    def validate_mount_bookkeeping(self, directory: Path) -> None:
        try:
            info = directory.lstat()
            entries = list(directory.iterdir())
        except OSError:
            raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != self.platform_uid() or
                stat.S_IMODE(info.st_mode) != 0o755):
            raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
        if {entry.name for entry in entries} - {"utab", "utab.lock"}:
            raise UpdateError("EPHEMERAL_DATA_PRESENT")
        for entry in entries:
            entry_info = entry.lstat()
            mode = stat.S_IMODE(entry_info.st_mode)
            if (not stat.S_ISREG(entry_info.st_mode) or entry_info.st_uid != self.platform_uid() or
                    entry_info.st_nlink != 1 or mode not in {0o600, 0o644} or entry_info.st_size > 256 * 1024):
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
            content = entry.read_bytes()
            if entry.name == "utab.lock" and content:
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
            if b"\0" in content:
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError:
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
            if any(len(line) > 8192 or any(ord(character) < 32 and character != "\t" for character in line)
                   for line in text.splitlines()):
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")

    def platform_uid(self) -> int:
        return 0

    def host_resolver_target(self) -> Path:
        return Path("/etc/resolv.conf").resolve()

    def resolver_bytes(self) -> bytes:
        return Path("/run/companions-headless-resolv.conf").read_bytes()

    def validate_devices(self, root: Path) -> None:
        expected = {"null": (1, 3), "zero": (1, 5), "random": (1, 8), "urandom": (1, 9)}
        device_root = root / "dev"
        if {entry.name for entry in device_root.iterdir()} != set(expected):
            raise UpdateError("EPHEMERAL_DATA_PRESENT")
        for name, numbers in expected.items():
            info = (device_root / name).lstat()
            if (not stat.S_ISCHR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o666 or
                    (os.major(info.st_rdev), os.minor(info.st_rdev)) != numbers):
                raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")

    def validate_git_brokers(self, root: Path, names: set[str]) -> None:
        try:
            agent_uid = pwd.getpwnam("companions-agent").pw_uid
        except KeyError:
            raise UpdateError("UNKNOWN_EPHEMERAL_LAYOUT")
        for name in names:
            directory = root / "tmp" / name
            try:
                info = directory.lstat()
                entries = list(directory.iterdir())
                socket_info = entries[0].lstat() if len(entries) == 1 else None
            except OSError:
                raise UpdateError("EPHEMERAL_DATA_PRESENT")
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != agent_uid or stat.S_IMODE(info.st_mode) != 0o700 or
                    len(entries) != 1 or entries[0].name != "broker.sock" or
                    not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != agent_uid or
                    stat.S_IMODE(socket_info.st_mode) != 0o600):
                raise UpdateError("EPHEMERAL_DATA_PRESENT")

    def stop_runtime(self) -> None:
        self.command("systemctl", "stop", *PROXY_UNITS, UNIT)

    def freeze_runtime(self) -> None:
        if self.command("systemctl", "freeze", UNIT, check=False).returncode:
            raise UpdateError("FREEZE_UNAVAILABLE")

    def thaw_runtime(self) -> None:
        self.command("systemctl", "thaw", UNIT, check=False)

    def start_runtime(self) -> None:
        self.command("systemctl", "start", UNIT, PROXY_UNITS[0])

    def wait_runtime(self) -> bool:
        for _ in range(40):
            if self.service_active() and self.executable_hash():
                return True
            time.sleep(0.25)
        return False

    def copy_distribution(self, candidate: Path) -> None:
        if candidate.exists():
            raise UpdateError("RECOVERY_REQUIRED")
        # GNU cp -a preserves ownership, modes, timestamps, xattrs and custom symlinks.
        self.command("cp", "-a", "--reflink=auto", "--", str(self.install), str(candidate))

    def exchange(self, left: Path, right: Path) -> None:
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = getattr(libc, "renameat2", None)
        if renameat2 is None:
            raise UpdateError("ATOMIC_EXCHANGE_UNAVAILABLE")
        result = renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2)
        if result:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        directory = os.open(left.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def executable_hash(self) -> str | None:
        try:
            processes = self.service_processes()
            daemon = [(pid, command) for pid, command in processes if command.startswith("/opt/companions/companion-agent")]
            if len(daemon) != 1:
                return None
            return sha256_path(Path(f"/proc/{daemon[0][0]}/exe"))
        except (OSError, UpdateError):
            return None


class Installer:
    def __init__(self, system: LinuxSystem):
        self.system = system

    def journal_path(self, update_id: str) -> Path:
        return self.system.state / f"{update_id}.json"

    def read_journal(self, update_id: str) -> dict | None:
        path = self.journal_path(update_id)
        if not path.exists():
            return None
        try:
            value = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            raise UpdateError("CORRUPT_JOURNAL")
        if value.get("updateId") != update_id:
            raise UpdateError("CORRUPT_JOURNAL")
        return value

    def persist(self, journal: dict, phase: str, state: str = "pending", code: str = "PENDING") -> None:
        journal.update(phase=phase, state=state, code=code)
        atomic_json(self.journal_path(journal["updateId"]), journal)

    def hashes_at(self, root: Path) -> dict[str, str] | None:
        values = {}
        try:
            for name in RUNTIME_FILES:
                path = root / name
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    return None
                values[name] = sha256_path(path)
        except OSError:
            return None
        return values

    def runtime_snapshot(self, root: Path) -> dict[str, str | None] | None:
        values = {}
        for name in RUNTIME_FILES:
            path = root / name
            try:
                info = path.lstat()
            except FileNotFoundError:
                if name == "runtime-release.json":
                    values[name] = None
                    continue
                return None
            except OSError:
                return None
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                return None
            values[name] = sha256_path(path)
        return values

    def validate_staging(self, staging: Path, expected: dict[str, str]) -> None:
        try:
            resolved = staging.resolve(strict=True)
        except OSError:
            raise UpdateError("INVALID_STAGING")
        if not staging.is_absolute() or resolved != staging or staging.is_symlink() or not staging.is_dir():
            raise UpdateError("INVALID_STAGING")
        allowed = set(RUNTIME_FILES) | {"update-runtime.py"}
        if {entry.name for entry in staging.iterdir()} - allowed:
            raise UpdateError("INVALID_STAGING")
        for name, digest in expected.items():
            path = staging / name
            try:
                info = path.lstat()
            except OSError:
                raise UpdateError("INVALID_STAGING")
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise UpdateError("INVALID_STAGING")
            if sha256_path(path) != digest:
                raise UpdateError("DIGEST_MISMATCH")
        self.validate_manifest(staging / "runtime-release.json", expected)

    def copy_verified_file(self, source: Path, destination: Path, expected: str) -> None:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            source_fd = os.open(source, flags)
            info = os.fstat(source_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise UpdateError("INVALID_STAGING")
            digest = hashlib.sha256()
            with os.fdopen(source_fd, "rb") as reader, destination.open("xb") as writer:
                for chunk in iter(lambda: reader.read(1024 * 1024), b""):
                    digest.update(chunk)
                    writer.write(chunk)
                writer.flush()
                os.fsync(writer.fileno())
        except OSError:
            raise UpdateError("INVALID_STAGING")
        if digest.hexdigest() != expected:
            destination.unlink(missing_ok=True)
            raise UpdateError("DIGEST_MISMATCH")

    def validate_manifest(self, path: Path, expected: dict[str, str]) -> None:
        try:
            manifest = json.loads(path.read_text())
            descriptors = manifest["files"]
            actual = {entry["path"]: (entry["sha256"], entry["size"]) for entry in descriptors}
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
            raise UpdateError("INVALID_MANIFEST")
        if manifest.get("schemaVersion") != 1 or manifest.get("protocolVersion") != 1 or manifest.get("stateVersion") != 1:
            raise UpdateError("INVALID_MANIFEST")
        if set(actual) != set(PAYLOAD_FILES) or len(descriptors) != 3:
            raise UpdateError("INVALID_MANIFEST")
        for name in PAYLOAD_FILES:
            if actual[name] != (expected[name], (path.parent / name).stat().st_size):
                raise UpdateError("INVALID_MANIFEST")
        # Match JSON.stringify(files): declared order and key order are part of the release id.
        canonical = [{"path": name, "size": actual[name][1], "sha256": actual[name][0]} for name in PAYLOAD_FILES]
        identifier = hashlib.sha256(json.dumps(canonical, separators=(",", ":")).encode()).hexdigest()
        if manifest.get("id") != identifier:
            raise UpdateError("INVALID_MANIFEST")

    def apply(self, args) -> dict:
        expected = expected_hashes(args)
        digest = release_digest(expected)
        existing = self.read_journal(args.update_id)
        if existing:
            if existing.get("digest") != digest:
                raise UpdateError("UPDATE_ID_CONFLICT")
            if existing.get("state") in {"succeeded", "rolled_back", "failed"}:
                return existing
            if existing.get("state") != "deferred":
                raise UpdateError("RECOVERY_REQUIRED")
        staging = Path(args.staging_dir)
        self.validate_staging(staging, expected)
        candidate = self.system.install.parent / f".{self.system.install.name}-runtime-new-{args.update_id}"
        retained = self.system.install.parent / f".{self.system.install.name}-runtime-old-{args.update_id}"
        old_hashes = self.runtime_snapshot(self.system.install)
        if old_hashes is None:
            raise UpdateError("UNSAFE_INSTALLED_RUNTIME")
        journal = existing or self.new_result(args.update_id, digest, "accepted", "pending", "PENDING")
        journal.update(expected=expected, oldHashes=old_hashes, candidate=str(candidate), retainedPath=str(retained), wasActive=self.system.service_active())
        self.persist(journal, "preflight_pending")
        try:
            self.system.preflight()
        except UpdateError as error:
            if error.code not in DEFERRED:
                raise
            self.persist(journal, "preflight", "deferred", error.code)
            return journal
        self.persist(journal, "copy_pending")
        try:
            if not candidate.exists():
                self.system.copy_distribution(candidate)
                for name in RUNTIME_FILES:
                    destination = candidate / name
                    if destination.exists() or destination.is_symlink():
                        destination.unlink()
                    source = staging / name
                    self.copy_verified_file(source, destination, expected[name])
                    os.chmod(destination, 0o755 if name == "companion-agent" else 0o644)
            if self.hashes_at(candidate) != expected:
                raise UpdateError("DIGEST_MISMATCH")
            self.validate_manifest(candidate / "runtime-release.json", expected)
            self.persist(journal, "candidate_ready")
            # Freeze closes the scan-to-stop race: no child can appear after this scan.
            self.system.preflight()
            if self.system.service_active():
                self.persist(journal, "freeze_pending")
                try:
                    self.system.freeze_runtime()
                    journal["frozen"] = True
                    self.persist(journal, "frozen")
                    self.system.preflight()
                except UpdateError as error:
                    self.system.thaw_runtime()
                    journal["frozen"] = False
                    if error.code in DEFERRED:
                        self.persist(journal, "preflight", "deferred", error.code)
                        return journal
                    raise
            self.persist(journal, "stop_pending")
            self.system.stop_runtime()
            journal["frozen"] = False
            self.persist(journal, "swap_pending")
            self.system.exchange(self.system.install, candidate)
            candidate.rename(retained)
            journal["retainedPath"] = str(retained)
            self.persist(journal, "start_pending")
            self.system.start_runtime()
            if self.hashes_at(self.system.install) != expected or not self.system.wait_runtime():
                raise UpdateError("HEALTH_CHECK_FAILED")
            executable = self.system.executable_hash()
            if executable and executable != expected["companion-agent"]:
                raise UpdateError("HEALTH_CHECK_FAILED")
            journal["installedDigest"] = self.installed_digest()
            self.persist(journal, "complete", "succeeded", "OK")
            return journal
        except Exception as error:
            return self.rollback(journal, error)

    def rollback(self, journal: dict, error: Exception) -> dict:
        code = error.code if isinstance(error, UpdateError) else "FAILED"
        expected, old = journal.get("expected"), journal.get("oldHashes")
        retained = Path(journal["retainedPath"])
        try:
            if journal.get("frozen") or journal.get("phase") in {"freeze_pending", "frozen", "stop_pending"}:
                self.system.thaw_runtime()
                journal["frozen"] = False
            installed = self.hashes_at(self.system.install)
            if installed == expected and retained.exists():
                self.persist(journal, "rollback_stop_pending")
                self.system.stop_runtime()
                self.persist(journal, "rollback_swap_pending")
                self.system.exchange(self.system.install, retained)
            if journal.get("wasActive"):
                self.system.start_runtime()
                if not self.system.wait_runtime() or self.system.executable_hash() != old.get("companion-agent"):
                    raise UpdateError("ROLLBACK_FAILED")
            if old is not None and self.runtime_snapshot(self.system.install) != old:
                raise UpdateError("ROLLBACK_FAILED")
            journal["installedDigest"] = self.installed_digest()
            self.persist(journal, "rolled_back", "rolled_back", "ROLLED_BACK")
        except Exception:
            self.persist(journal, "failed", "failed", code)
        return journal

    def reconcile(self, update_id: str, digest: str | None) -> dict:
        journal = self.read_journal(update_id)
        if not journal:
            return self.new_result(update_id, digest, "none", "not_started", "NOT_STARTED")
        if digest and journal.get("digest") != digest:
            raise UpdateError("UPDATE_ID_CONFLICT")
        digest = journal["digest"]
        if journal.get("state") != "pending":
            return journal
        if str(journal.get("phase", "")).startswith("rollback_"):
            return self.requested_rollback(update_id, digest)
        expected = journal.get("expected")
        retained = Path(journal["retainedPath"])
        if self.hashes_at(self.system.install) == expected:
            try:
                candidate = Path(journal.get("candidate") or "")
                if not retained.exists() and candidate.is_absolute() and candidate.exists():
                    candidate.rename(retained)
                if journal.get("wasActive") and not self.system.service_active():
                    self.system.start_runtime()
                if not journal.get("wasActive") or self.system.wait_runtime():
                    journal["installedDigest"] = self.installed_digest()
                    self.persist(journal, "complete", "succeeded", "OK")
                    return journal
            except Exception:
                pass
        return self.rollback(journal, UpdateError("RECOVERY_REQUIRED"))

    def requested_rollback(self, update_id: str, digest: str | None) -> dict:
        journal = self.read_journal(update_id)
        if not journal:
            return self.new_result(update_id, digest, "none", "not_started", "NOT_STARTED")
        if digest and journal.get("digest") != digest:
            raise UpdateError("UPDATE_ID_CONFLICT")
        digest = journal["digest"]
        if journal.get("state") == "rolled_back":
            return journal
        old_snapshot = journal.get("oldHashes")
        if self.runtime_snapshot(self.system.install) == old_snapshot:
            if journal.get("frozen") or journal.get("phase") in {"freeze_pending", "frozen", "stop_pending"}:
                self.system.thaw_runtime()
                journal["frozen"] = False
            if journal.get("wasActive") and not self.system.service_active():
                self.system.start_runtime()
            if journal.get("wasActive") and (not self.system.wait_runtime() or
                                              self.system.executable_hash() != old_snapshot.get("companion-agent")):
                raise UpdateError("ROLLBACK_FAILED")
            journal["installedDigest"] = self.installed_digest()
            self.persist(journal, "rolled_back", "rolled_back", "ROLLED_BACK")
            return journal
        retained = Path(journal.get("retainedPath") or "")
        if not retained.is_absolute() or not retained.exists():
            raise UpdateError("ROLLBACK_UNAVAILABLE")
        if self.runtime_snapshot(retained) != journal.get("oldHashes"):
            raise UpdateError("ROLLBACK_UNAVAILABLE")
        # Clone the current distribution, then restore only runtime entries. This
        # preserves any custom files added after the update succeeded.
        rollback_value = journal.get("rollbackCandidate")
        rollback = Path(rollback_value) if rollback_value else Path()
        if not rollback_value or not rollback.is_absolute() or (rollback.exists() and self.runtime_snapshot(rollback) != old_snapshot):
            attempt = int(journal.get("rollbackAttempt", 0)) + 1
            rollback = self.system.install.parent / f".{self.system.install.name}-runtime-rollback-{update_id}-{attempt}"
            journal.update(rollbackAttempt=attempt, rollbackCandidate=str(rollback))
            self.persist(journal, "rollback_copy_pending", "pending", "PENDING")
        if not rollback.exists():
            self.system.copy_distribution(rollback)
            for name in RUNTIME_FILES:
                source, destination = retained / name, rollback / name
                if destination.exists() or destination.is_symlink():
                    destination.unlink()
                if source.exists():
                    shutil.copy2(source, destination, follow_symlinks=False)
            if self.runtime_snapshot(rollback) != old_snapshot:
                raise UpdateError("ROLLBACK_FAILED")
        self.persist(journal, "rollback_ready", "pending", "PENDING")
        self.persist(journal, "rollback_stop_pending", "pending", "PENDING")
        self.system.stop_runtime()
        self.persist(journal, "rollback_swap_pending", "pending", "PENDING")
        self.system.exchange(self.system.install, rollback)
        if journal.get("wasActive"):
            self.system.start_runtime()
            if not self.system.wait_runtime() or self.system.executable_hash() != old_snapshot.get("companion-agent"):
                raise UpdateError("ROLLBACK_FAILED")
        journal["failedRuntimePath"] = str(rollback)
        journal["installedDigest"] = self.installed_digest()
        self.persist(journal, "rolled_back", "rolled_back", "ROLLED_BACK")
        return journal

    def new_result(self, update_id, digest, phase, state, code) -> dict:
        return {"schemaVersion": 1, "updateId": update_id, "digest": digest, "phase": phase,
                "state": state, "code": code, "installedDigest": self.installed_digest(), "retainedPath": None}

    def installed_digest(self) -> str | None:
        hashes = self.runtime_snapshot(self.system.install)
        return release_digest(hashes) if hashes else None

    def probe(self) -> dict:
        hashes = self.runtime_snapshot(self.system.install)
        release_id = None
        if hashes:
            try:
                release_id = json.loads((self.system.install / "runtime-release.json").read_text()).get("id")
            except (OSError, json.JSONDecodeError):
                pass
        code = "OK"
        try:
            self.system.preflight()
        except UpdateError as error:
            code = error.code
        return {"schemaVersion": 1, "capable": True, "state": "ready" if code == "OK" else "deferred",
                "code": code, "releaseId": release_id,
                "hashes": hashes, "installedDigest": release_digest(hashes) if hashes else None}


def expected_hashes(args) -> dict[str, str]:
    values = {
        "companion-agent": args.companion_agent_sha256,
        "photon_rs_bg.wasm": args.photon_rs_bg_wasm_sha256,
        "package.json": args.package_json_sha256,
        "runtime-release.json": args.manifest_sha256,
    }
    if any(not HEX.fullmatch(value or "") for value in values.values()):
        raise UpdateError("INVALID_DIGEST")
    return values


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("probe")
    status = commands.add_parser("status")
    status.add_argument("--update-id", required=True)
    status.add_argument("--digest")
    reconcile = commands.add_parser("reconcile")
    reconcile.add_argument("--update-id", required=True)
    reconcile.add_argument("--digest")
    rollback = commands.add_parser("rollback")
    rollback.add_argument("--update-id", required=True)
    rollback.add_argument("--digest")
    apply = commands.add_parser("apply")
    apply.add_argument("--update-id", required=True)
    apply.add_argument("--staging-dir", required=True)
    for option in ("companion-agent", "photon-rs-bg-wasm", "package-json", "manifest"):
        apply.add_argument(f"--{option}-sha256", required=True)
    return result


def valid_id(value: str) -> str:
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        raise UpdateError("INVALID_UPDATE_ID")
    if str(parsed) != value.lower():
        raise UpdateError("INVALID_UPDATE_ID")
    return value.lower()


def run(arguments=None, system=None) -> tuple[dict, int]:
    args = parser().parse_args(arguments)
    system = system or LinuxSystem()
    system.require_root()
    installer = Installer(system)
    if args.command == "probe":
        return installer.probe(), 0
    update_id = valid_id(args.update_id)
    if args.command == "status":
        journal = installer.read_journal(update_id)
        if not journal:
            journal = installer.new_result(update_id, args.digest, "none", "not_started", "NOT_STARTED")
        elif args.digest and journal.get("digest") != args.digest:
            raise UpdateError("UPDATE_ID_CONFLICT")
        return journal, EXIT.get(journal["state"], 1)
    lock_path = system.state / "update.lock"
    with lock_path.open("a+") as lock:
        os.chmod(lock_path, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            value = installer.new_result(update_id, getattr(args, "digest", None), "locked", "deferred", "UPDATE_IN_PROGRESS")
            return value, 75
        if args.command in {"reconcile", "rollback"}:
            if args.digest and not HEX.fullmatch(args.digest):
                raise UpdateError("INVALID_DIGEST")
            value = (installer.reconcile(update_id, args.digest) if args.command == "reconcile"
                     else installer.requested_rollback(update_id, args.digest))
        else:
            args.update_id = update_id
            value = installer.apply(args)
        return value, EXIT.get(value["state"], 1)


def main() -> None:
    try:
        value, exit_code = run()
    except UpdateError as error:
        value, exit_code = {"schemaVersion": 1, "state": "failed", "code": error.code, "phase": "rejected"}, 2
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
