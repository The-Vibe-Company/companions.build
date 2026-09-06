"""Start an isolated PostgreSQL + API + executor + web workspace. Ctrl-C stops application processes."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from bun import ROOT, module

os.chdir(ROOT)
env = os.environ.copy()
# Bun loads .env itself; parse only the port/workspace settings needed by the launcher.
if (ROOT / ".env").exists():
    for line in (ROOT / ".env").read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key in ("WEB_PORT", "API_PORT", "DATABASE_URL", "COMPANIONS_DATA_DIR", "AGENT_TEST_MODE"):
            env.setdefault(key, value.strip().strip('"').strip("'"))
workspace = hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
base = int(env.get("CONDUCTOR_PORT", env.get("WEB_PORT", str(4000 + int(workspace[:4], 16) % 2000 * 10))))
env.setdefault("WEB_PORT", str(base))
env.setdefault("API_PORT", str(base + 1))
env.setdefault("APP_URL", f"http://127.0.0.1:{base}")
env.setdefault("AGENT_TEST_MODE", "1")
env.setdefault("COMPANIONS_DATA_DIR", str(ROOT / ".local"))
name = f"companions-pg-{workspace}"
bun = module.toolchain()

def run(args, **kwargs):
    return subprocess.run(args, check=True, env=env, **kwargs)

run(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
if "DATABASE_URL" not in env:
    found = subprocess.run(["docker", "inspect", name], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if found.returncode:
        run(["docker", "run", "--detach", "--name", name, "--label", f"companions.build.workspace={workspace}",
             "--publish", f"127.0.0.1:{base+2}:5432", "--env", "POSTGRES_USER=companions", "--env", "POSTGRES_PASSWORD=companions",
             "--env", "POSTGRES_DB=companions", "--volume", f"{name}:/var/lib/postgresql/data", "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"])
    elif not json.loads(found.stdout)[0]["State"]["Running"]:
        run(["docker", "start", name])
    # Reuse the actual mapping if a checkout is relaunched with a different web port.
    database_address = subprocess.check_output(["docker", "port", name, "5432/tcp"], text=True).strip()
    env["DATABASE_URL"] = f"postgres://companions:companions@{database_address}/companions"
    for attempt in range(60):
        ready = subprocess.run(["docker", "exec", name, "pg_isready", "-U", "companions"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ready.returncode == 0: break
        time.sleep(0.5)
    else: raise SystemExit("PostgreSQL did not become ready")
run([bun, "install", "--frozen-lockfile"])
run([bun, "install", "--frozen-lockfile"], cwd=ROOT / "apps/web")
run([bun, "scripts/build-agent.ts"])
children = []
def stop(*_):
    for child in children:
        if child.poll() is None: os.killpg(child.pid, signal.SIGTERM)
    for child in children:
        try: child.wait(timeout=5)
        except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
try:
    for args, cwd in [([bun, "apps/server/src/api.ts"], ROOT), ([bun, "apps/server/src/executor.ts"], ROOT),
                      ([bun, "run", "dev", "--host", "127.0.0.1", "--port", str(base)], ROOT / "apps/web")]:
        children.append(subprocess.Popen(args, cwd=cwd, env=env, start_new_session=True))
    print(f"\nCompanions: http://127.0.0.1:{base}\nAccess token: read {env['COMPANIONS_DATA_DIR']}/operator-token\n", flush=True)
    while all(child.poll() is None for child in children): time.sleep(0.5)
    failed_code = next((child.returncode for child in children if child.returncode is not None), 1)
    raise SystemExit(failed_code or 1)
except KeyboardInterrupt: pass
finally: stop()
