"""Verify a fresh checkout with isolated PostgreSQL, real Pi/Linux and frontend tests."""
import argparse
import hashlib
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

POSTGRES_IMAGES = {
    "17": "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
    "18": "postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280",
}
parser = argparse.ArgumentParser()
parser.add_argument("--postgres", choices=POSTGRES_IMAGES, default="17", help="PostgreSQL major used for both the crash source and isolated recovery target")
validation_order = ["typecheck", "agent-unit", "specialist-init-and-git", "specialist-image-linux", "distribution-content-linux", "agent-build", "system", "web-tests", "web-build", "postgres-restore-seed"]
parser.add_argument("--from-step", choices=validation_order, help="Resume remaining validation after fixing a failed step; earlier checks are recorded as skipped")
args = parser.parse_args()

os.chdir(ROOT)
bun = module.toolchain()
postgres_image = POSTGRES_IMAGES[args.postgres]
run_id = uuid.uuid4().hex[:12]
artifacts = ROOT / ".artifacts/verification" / run_id
artifacts.mkdir(parents=True)
artifacts.chmod(0o700)
database_name = f"companions-verify-postgres-{run_id}"
database_volume = f"companions-verify-postgres-data-{run_id}"
storage_name = f"companions-verify-minio-{run_id}"
verification_label = f"companions.build.verification={run_id}"
env = {**os.environ, "AGENT_TEST_MODE": "1", "COMPANIONS_VERIFY_RUN": run_id}
steps = []
started = time.monotonic()

def run(label, args, cwd=ROOT, timeout=180):
    if label in validation_order and args_from_step and validation_order.index(label) < validation_order.index(args_from_step):
        steps.append({"name": label, "status": "skipped"})
        return
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
args_from_step = args.from_step
try:
    postgres_data_path = "/var/lib/postgresql" if args.postgres == "18" else "/var/lib/postgresql/data"
    run("database-volume", ["docker", "volume", "create", "--label", verification_label, database_volume])
    run("database", ["docker", "run", "--detach", "--name", database_name, "--label", verification_label,
        "--publish", "127.0.0.1::5432",
        "--volume", f"{database_volume}:{postgres_data_path}",
        "--env", "POSTGRES_USER=companions", "--env", "POSTGRES_PASSWORD=companions", "--env", "POSTGRES_DB=companions", postgres_image])
    mapping = subprocess.check_output(["docker", "port", database_name, "5432/tcp"], text=True).strip()
    env["DATABASE_URL"] = f"postgres://companions:companions@{mapping}/companions"
    for attempt in range(60):
        if subprocess.run(["docker", "exec", database_name, "pg_isready", "-h", "127.0.0.1", "-U", "companions"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0: break
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
    run("agent-unit", [bun, "test", "packages/agent/test/daemon.test.ts", "packages/agent/test/environment.test.ts", "packages/agent/test/initialization.test.ts", "packages/agent/test/memory.test.ts", "packages/agent/test/skills.test.ts", "packages/desktop/desktop.test.ts", "packages/control/software.test.ts", "packages/box/software-install.test.ts", "packages/box/software-build.test.ts", "packages/box/software-resolve.test.ts", "packages/box/software-resolve-apt.test.ts", "packages/box/software-distribution.test.ts", "packages/box/software-builder-cli.test.ts", "scripts/register-software-base.test.ts", "scripts/lib/distribution-verification.test.ts", "scripts/live-desktop-canary-wait.test.ts", "scripts/live-box-desktop-wait.test.ts", "scripts/live-routine-chat-canary.test.ts", "scripts/live-routine-clock-canary.test.ts"])
    run("specialist-init-and-git", [bun, "test", "packages/agent/test/specialist-initialization.test.ts", "packages/agent/test/git-credentials.test.ts"])
    run("specialist-image-linux", [bun, "scripts/test-specialist-image.ts"])
    run("distribution-content-linux", [bun, "scripts/test-distribution-verification.ts"])
    run("agent-build", [bun, "scripts/build-agent.ts"])
    run("system", [bun, "scripts/test-server.ts", "--linux"])
    run("web-tests", [bun, "run", "test"], ROOT / "apps/web")
    run("web-build", [bun, "run", "build"], ROOT / "apps/web")
    restore_state = artifacts / "postgres-restore-state.json"
    backup = artifacts / "postgres-backup.dump"
    env["COMPANIONS_DATA_DIR"] = str(artifacts / "postgres-restore-config")
    run("postgres-restore-seed", [bun, "scripts/test-postgres-restore.ts", "seed", str(restore_state)])
    run("postgres-backup", ["docker", "exec", database_name, "pg_dump", "--username", "companions", "--dbname", "companions", "--format", "custom", "--file", "/tmp/companions.dump"])
    run("postgres-backup-copy", ["docker", "cp", f"{database_name}:/tmp/companions.dump", str(backup)])
    backup.chmod(0o600)
    backup_sha256 = hashlib.sha256(backup.read_bytes()).hexdigest()
    run("postgres-crash", ["docker", "kill", database_name])
    recovery_name = f"companions-verify-postgres-recovery-{run_id}"
    recovery_volume = f"companions-verify-postgres-recovery-data-{run_id}"
    run("postgres-recovery-volume", ["docker", "volume", "create", "--label", verification_label, recovery_volume])
    run("postgres-recovery", ["docker", "run", "--detach", "--name", recovery_name, "--label", verification_label,
        "--publish", "127.0.0.1::5432", "--volume", f"{recovery_volume}:{postgres_data_path}",
        "--env", "POSTGRES_USER=companions", "--env", "POSTGRES_PASSWORD=companions",
        "--env", "POSTGRES_DB=companions", postgres_image])
    recovery_mapping = subprocess.check_output(["docker", "port", recovery_name, "5432/tcp"], text=True).strip()
    for attempt in range(60):
        if subprocess.run(["docker", "exec", recovery_name, "pg_isready", "-h", "127.0.0.1", "-U", "companions"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0: break
        time.sleep(.5)
    else: raise RuntimeError("Recovery PostgreSQL readiness timed out")
    run("postgres-restore-copy", ["docker", "cp", str(backup), f"{recovery_name}:/tmp/companions.dump"])
    run("postgres-restore", ["docker", "exec", recovery_name, "pg_restore", "--exit-on-error", "--username", "companions", "--dbname", "companions", "/tmp/companions.dump"])
    recovery_port = recovery_mapping.rsplit(":", 1)[-1]
    env["DATABASE_URL"] = f"postgres://companions:companions@127.0.0.1:{recovery_port}/companions"
    run("postgres-restore-verify", [bun, "scripts/test-postgres-restore.ts", "verify", str(restore_state)])
    status = "passed"
finally:
    owned = subprocess.run(["docker", "ps", "-aq", "--filter", f"label=companions.build.verification={run_id}"], text=True, capture_output=True)
    if owned.returncode:
        status = "failed"
    elif owned.stdout.split():
        cleanup = subprocess.run(["docker", "rm", "-f", "-v", *owned.stdout.split()], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if cleanup.returncode: status = "failed"
    volumes = subprocess.run(["docker", "volume", "ls", "-q", "--filter", f"label=companions.build.verification={run_id}"], text=True, capture_output=True)
    if volumes.returncode:
        status = "failed"
    elif volumes.stdout.split():
        cleanup = subprocess.run(["docker", "volume", "rm", *volumes.stdout.split()], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if cleanup.returncode: status = "failed"
    report = {"status": status, "run": run_id, "seconds": round(time.monotonic()-started, 3),
        "resumeFrom": args_from_step,
        "postgres": {"major": int(args.postgres), "image": postgres_image,
            **({"backupSha256": backup_sha256} if "backup_sha256" in locals() else {})}, "steps": steps}
    (artifacts / "summary.json").write_text(json.dumps(report, indent=2))
    print(f"{status.upper()}: {artifacts.relative_to(ROOT)}", flush=True)
