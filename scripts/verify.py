"""Verify a fresh checkout with isolated PostgreSQL, real Pi/Linux and frontend tests."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import uuid
from bun import ROOT, module

os.chdir(ROOT)
bun = module.toolchain()
run_id = uuid.uuid4().hex[:12]
artifacts = ROOT / ".artifacts/verification" / run_id
artifacts.mkdir(parents=True)
name = f"companions-verify-{run_id}"
env = {**os.environ, "AGENT_TEST_MODE": "1", "COMPANIONS_VERIFY_RUN": run_id}
steps = []
started = time.monotonic()

def run(label, args, cwd=ROOT, timeout=180):
    print(f"[{label}]", flush=True)
    before = time.monotonic()
    with (artifacts / f"{label}.log").open("w") as log:
        child = subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try: code = child.wait(timeout=timeout)
        except BaseException:
            os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL)
            raise
    steps.append({"name": label, "exitCode": code, "seconds": round(time.monotonic()-before, 3)})
    if code:
        print((artifacts / f"{label}.log").read_text()[-8000:])
        raise RuntimeError(f"{label} failed")

status = "failed"
try:
    run("database", ["docker", "run", "--detach", "--name", name, "--publish", "127.0.0.1::5432",
        "--env", "POSTGRES_USER=companions", "--env", "POSTGRES_PASSWORD=companions", "--env", "POSTGRES_DB=companions", "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"])
    mapping = subprocess.check_output(["docker", "port", name, "5432/tcp"], text=True).strip()
    env["DATABASE_URL"] = f"postgres://companions:companions@{mapping}/companions"
    for attempt in range(60):
        if subprocess.run(["docker", "exec", name, "pg_isready", "-U", "companions"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0: break
        time.sleep(.5)
    else: raise RuntimeError("PostgreSQL readiness timed out")
    run("install", [bun, "install", "--frozen-lockfile"])
    run("web-install", [bun, "install", "--frozen-lockfile"], ROOT / "apps/web")
    run("typecheck", [bun, "node_modules/typescript/bin/tsc"])
    run("agent-unit", [bun, "test", "packages/agent/test/daemon.test.ts", "packages/agent/test/environment.test.ts", "packages/agent/test/initialization.test.ts"])
    run("agent-build", [bun, "scripts/build-agent.ts"])
    run("system", [bun, "scripts/test-server.ts", "--linux"])
    run("web-tests", [bun, "run", "test"], ROOT / "apps/web")
    run("web-build", [bun, "run", "build"], ROOT / "apps/web")
    status = "passed"
finally:
    owned = subprocess.run(["docker", "ps", "-aq", "--filter", f"label=companions.build.verification={run_id}"], text=True, capture_output=True)
    if owned.returncode == 0 and owned.stdout.split():
        cleanup = subprocess.run(["docker", "rm", "-f", *owned.stdout.split()], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if cleanup.returncode: status = "failed"
    subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    report = {"status": status, "run": run_id, "seconds": round(time.monotonic()-started, 3), "steps": steps}
    (artifacts / "summary.json").write_text(json.dumps(report, indent=2))
    print(f"{status.upper()}: {artifacts.relative_to(ROOT)}", flush=True)
