"""Verify a fresh checkout with isolated PostgreSQL, real Pi/Linux and frontend tests."""
import json
import os
from pathlib import Path
import signal
import secrets
import subprocess
import time
import urllib.request
import uuid
from bun import ROOT, module

os.chdir(ROOT)
bun = module.toolchain()
run_id = uuid.uuid4().hex[:12]
artifacts = ROOT / ".artifacts/verification" / run_id
artifacts.mkdir(parents=True)
database_name = f"companions-verify-postgres-{run_id}"
storage_name = f"companions-verify-minio-{run_id}"
verification_label = f"companions.build.verification={run_id}"
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
    run("database", ["docker", "run", "--detach", "--name", database_name, "--label", verification_label,
        "--publish", "127.0.0.1::5432",
        "--env", "POSTGRES_USER=companions", "--env", "POSTGRES_PASSWORD=companions", "--env", "POSTGRES_DB=companions", "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"])
    mapping = subprocess.check_output(["docker", "port", database_name, "5432/tcp"], text=True).strip()
    env["DATABASE_URL"] = f"postgres://companions:companions@{mapping}/companions"
    for attempt in range(60):
        if subprocess.run(["docker", "exec", database_name, "pg_isready", "-U", "companions"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0: break
        time.sleep(.5)
    else: raise RuntimeError("PostgreSQL readiness timed out")
    storage_access_key = f"verify-{run_id}"
    storage_secret_key = secrets.token_hex(24)
    run("storage", ["docker", "run", "--detach", "--name", storage_name, "--label", verification_label,
        "--publish", "127.0.0.1::9000", "--env", f"MINIO_ROOT_USER={storage_access_key}",
        "--env", f"MINIO_ROOT_PASSWORD={storage_secret_key}",
        "minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e",
        "server", "/data"])
    storage_mapping = subprocess.check_output(["docker", "port", storage_name, "9000/tcp"], text=True).strip()
    storage_port = storage_mapping.rsplit(":", 1)[-1]
    storage_endpoint = f"http://127.0.0.1:{storage_port}"
    for attempt in range(60):
        try:
            with urllib.request.urlopen(f"{storage_endpoint}/minio/health/live", timeout=.5) as response:
                if response.status == 200: break
        except Exception: pass
        time.sleep(.5)
    else: raise RuntimeError("MinIO readiness timed out")
    run("storage-bucket", ["docker", "run", "--rm", "--label", verification_label,
        "--network", f"container:{storage_name}",
        "--env", f"MC_HOST_verify=http://{storage_access_key}:{storage_secret_key}@127.0.0.1:9000",
        "minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3",
        "mb", "--ignore-existing", "verify/companions-files"])
    env.update({"S3_ENDPOINT": storage_endpoint, "S3_ACCESS_KEY_ID": storage_access_key,
        "S3_SECRET_ACCESS_KEY": storage_secret_key, "S3_BUCKET_FILES": "companions-files", "S3_REGION": "us-east-1"})
    run("install", [bun, "install", "--frozen-lockfile"])
    run("web-install", [bun, "install", "--frozen-lockfile"], ROOT / "apps/web")
    run("typecheck", [bun, "node_modules/typescript/bin/tsc"])
    run("agent-unit", [bun, "test", "packages/agent/test/daemon.test.ts", "packages/agent/test/environment.test.ts", "packages/agent/test/initialization.test.ts", "packages/agent/test/memory.test.ts", "packages/agent/test/skills.test.ts", "packages/desktop/desktop.test.ts", "packages/control/software.test.ts", "packages/box/software-install.test.ts", "scripts/live-desktop-canary-wait.test.ts"])
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
    report = {"status": status, "run": run_id, "seconds": round(time.monotonic()-started, 3), "steps": steps}
    (artifacts / "summary.json").write_text(json.dumps(report, indent=2))
    print(f"{status.upper()}: {artifacts.relative_to(ROOT)}", flush=True)
