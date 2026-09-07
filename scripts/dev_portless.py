#!/usr/bin/env python3
"""Scoped Portless aliases for the non-web services in one development worktree."""

from contextlib import contextmanager
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlparse

from dev_support import LOCAL, ROOT, proxy_command, read_json, write_json

SERVICES = ("api", "storage", "s3", "mailpit")
MANIFEST = LOCAL / "dev-portless-routes.json"
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _primary_host(env: dict[str, str]) -> str:
    parsed = urlparse(env.get("PORTLESS_URL", ""))
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("PORTLESS_URL must be an HTTP(S) URL without credentials")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise RuntimeError("PORTLESS_URL must be an origin without a path, query, or fragment")
    return parsed.hostname


def _validated_ports(ports: dict[str, int]) -> dict[str, int]:
    if set(ports) != set(SERVICES):
        raise RuntimeError("Portless service ports must contain exactly: " + ", ".join(SERVICES))
    result: dict[str, int] = {}
    for name in SERVICES:
        port = ports[name]
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise RuntimeError(f"Invalid local port for {name}")
        result[name] = port
    return result


def _run(env: dict[str, str], *arguments: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run([*proxy_command(), *arguments], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Portless command timed out; inspect recorded route ownership before retrying") from None


def _url(env: dict[str, str], alias: str) -> str:
    result = _run(env, "get", alias, "--no-worktree")
    if result.returncode:
        raise RuntimeError(f"Portless could not resolve the {alias} alias")
    value = result.stdout.strip()
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname != alias:
        raise RuntimeError(f"Portless returned an unexpected URL for the {alias} alias")
    return value.rstrip("/")


def _route_port(env: dict[str, str], alias: str) -> int | None:
    result = _run(env, "list")
    if result.returncode:
        raise RuntimeError("Portless routes could not be inspected before cleanup")
    output = ANSI.sub("", result.stdout)
    match = re.search(rf"https?://{re.escape(alias)}(?::\d+)?\s+->\s+localhost:(\d+)\s+\(alias\)", output)
    return int(match.group(1)) if match else None


def _save(manifest: dict[str, object]) -> None:
    aliases = manifest.get("aliases", [])
    if aliases:
        write_json(MANIFEST, manifest)
    else:
        MANIFEST.unlink(missing_ok=True)


def _cleanup_manifest(env: dict[str, str], manifest: dict[str, object]) -> None:
    aliases = list(manifest.get("aliases", []))
    failures: list[str] = []
    for entry in reversed(aliases):
        name = entry.get("name")
        port = entry.get("port")
        state = entry.get("state")
        if not isinstance(name, str) or not isinstance(port, int):
            failures.append("invalid manifest entry")
            continue
        if state != "created":
            failures.append(f"{name} has ambiguous ownership ({state or 'unknown'})")
            continue
        try:
            current = _route_port(env, name)
            if current is not None and current != port:
                failures.append(f"{name} now targets a foreign port")
                continue
            if current is not None:
                removed = _run(env, "alias", "--remove", name)
                if removed.returncode:
                    failures.append(f"{name} could not be removed")
                    continue
                if _route_port(env, name) is not None:
                    failures.append(f"{name} is still registered after removal")
                    continue
            aliases.remove(entry)
            manifest["aliases"] = aliases
            _save(manifest)
        except RuntimeError as error:
            failures.append(str(error))
    if failures:
        raise RuntimeError("Portless cleanup incomplete: " + "; ".join(failures))


def register_services(env: dict[str, str], ports: dict[str, int]) -> dict[str, str]:
    """Register all worktree aliases, rolling back aliases created by a partial failure."""
    host = _primary_host(env)
    values = _validated_ports(ports)
    stale = read_json(MANIFEST)
    if stale.get("aliases"):
        raise RuntimeError("Stale Portless route ownership exists; run scripts/dev_portless.py cleanup")
    manifest: dict[str, object] = {"primaryHost": host, "aliases": []}
    urls: dict[str, str] = {}
    try:
        for service in SERVICES:
            alias = f"{service}.{host}"
            entry = {"service": service, "name": alias, "port": values[service], "state": "pending"}
            manifest["aliases"].append(entry)
            _save(manifest)
            result = _run(env, "alias", alias, str(values[service]))
            if result.returncode:
                manifest["aliases"].remove(entry)
                _save(manifest)
                raise RuntimeError(f"Portless alias collision or registration failure for {alias}")
            entry["state"] = "created"
            _save(manifest)
            urls[service] = _url(env, alias)
        return urls
    except BaseException:
        try:
            _cleanup_manifest(env, manifest)
        except RuntimeError as cleanup_error:
            raise RuntimeError(f"Portless registration failed and cleanup needs attention: {cleanup_error}")
        raise


def cleanup_stale(env: dict[str, str]) -> None:
    """Remove only aliases durably recorded as created by this exact worktree."""
    manifest = read_json(MANIFEST)
    if not manifest.get("aliases"):
        MANIFEST.unlink(missing_ok=True)
        return
    if manifest.get("primaryHost") != _primary_host(env):
        raise RuntimeError("Portless manifest belongs to a different primary worktree hostname")
    _cleanup_manifest(env, manifest)


@contextmanager
def routes(env: dict[str, str], ports: dict[str, int]):
    """Register service routes for a supervisor lifetime and always release owned aliases."""
    values = register_services(env, ports)
    try:
        yield values
    finally:
        cleanup_stale(env)


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["cleanup"])
    args = parser.parse_args()
    if args.command == "cleanup":
        cleanup_stale(dict(os.environ))
        print("Owned Portless service aliases removed.")


if __name__ == "__main__":
    main()
