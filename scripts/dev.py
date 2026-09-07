"""Start an isolated local Companion stack. Ctrl-C stops processes and service containers."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import socket
import time
import urllib.request
from bun import ROOT, module
from dev_support import lock, prepare, read_json, write_json, source_digest

os.chdir(ROOT)
stack_lock = lock("dev-stack.lock")
state_path = ROOT / ".local/dev-state.json"
process_identity = subprocess.check_output(["ps", "-p", str(os.getpid()), "-o", "lstart="], text=True).strip()
state = {"status": "starting", "pid": os.getpid(), "identity": process_identity, "services": {}}
write_json(state_path, state)
env = os.environ.copy()
launcher_keys = {
    "WEB_PORT", "API_PORT", "DATABASE_URL", "COMPANIONS_DATA_DIR", "AGENT_TEST_MODE",
    "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_FILES", "S3_REGION",
    "SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD",
}
# Bun loads .env itself; the launcher also needs local-service and workspace settings.
if env.get("COMPANIONS_DEV_LOCAL") != "1" and (ROOT / ".env").exists():
    for line in (ROOT / ".env").read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key in launcher_keys:
            env.setdefault(key, value.strip().strip('"').strip("'"))
workspace = hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
base = int(env.get("CONDUCTOR_PORT", env.get("WEB_PORT", str(4000 + int(workspace[:4], 16) % 2000 * 10))))
env.setdefault("WEB_PORT", env.get("PORT", str(base)) if env.get("PORTLESS_URL") else str(base))
env.setdefault("API_PORT", str(base + 1))
env.setdefault("APP_URL", env.get("PORTLESS_URL", f"http://127.0.0.1:{env['WEB_PORT']}"))
env.setdefault("BETTER_AUTH_URL", env["APP_URL"])
env.setdefault("AGENT_TEST_MODE", "1")
env.setdefault("COMPANIONS_DATA_DIR", str(ROOT / ".local"))
data_dir = Path(env["COMPANIONS_DATA_DIR"])
if not data_dir.is_absolute():
    data_dir = ROOT / data_dir
data_dir.mkdir(parents=True, exist_ok=True)
data_dir.chmod(0o700)
bun = module.toolchain()
logs = data_dir / "logs"
logs.mkdir(exist_ok=True, mode=0o700)
log_handles = []
children = []
managed_containers = []

POSTGRES_IMAGE = "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
MINIO_IMAGE = "minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"
MINIO_CLIENT_IMAGE = "minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3"
MAILPIT_IMAGE = "axllent/mailpit:v1.27.8@sha256:6abc8e633df15eaf785cfcf38bae48e66f64beecdc03121e249d0f9ec15f0707"

def bun_command(args):
    return [args[0], "--no-env-file", *args[1:]] if args[0] == bun and env.get("COMPANIONS_DEV_LOCAL") == "1" else args

def run(args, **kwargs):
    return subprocess.run(bun_command(args), check=True, env=env, **kwargs)

def container(name):
    found = subprocess.run(["docker", "inspect", name], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return None if found.returncode else json.loads(found.stdout)[0]

def ensure_container(name, args):
    details = container(name)
    if details is None:
        run(["docker", "run", "--detach", "--name", name,
             "--label", f"companions.build.workspace={workspace}", *args], stdout=subprocess.DEVNULL)
    elif details.get("Config", {}).get("Labels", {}).get("companions.build.workspace") != workspace:
        raise SystemExit("Local service ownership mismatch: " + name)
    elif not details["State"]["Running"]:
        run(["docker", "start", name], stdout=subprocess.DEVNULL)
    managed_containers.append(name)

def wait_http(url, label):
    for _ in range(60):
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status < 500:
                    return
        except Exception:
            time.sleep(0.5)
    raise SystemExit(f"{label} did not become ready")

def service_credentials():
    path = data_dir / "dev-services.json"
    if path.exists():
        value = json.loads(path.read_text())
        if isinstance(value.get("minioUser"), str) and isinstance(value.get("minioPassword"), str):
            return value
        raise SystemExit(f"Invalid local service credentials in {path}")
    value = {"minioUser": f"companions-{workspace}", "minioPassword": secrets.token_urlsafe(32)}
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(path)
    return value

def stop(*_):
    for child in children:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
    for child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    # Runtime containers use the data-directory hash; services use the checkout hash.
    clean = True
    for owner in {workspace, hashlib.sha256(str(data_dir.resolve()).encode()).hexdigest()[:10]}:
        selected = subprocess.run(["docker", "ps", "-q", "--filter", f"label=companions.build.workspace={owner}"], capture_output=True, text=True)
        if selected.returncode:
            clean = False
        elif selected.stdout.split():
            result = subprocess.run(["docker", "stop", "--time", "3", *selected.stdout.split()], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            clean = clean and result.returncode == 0
        remaining = subprocess.run(["docker", "ps", "-q", "--filter", f"label=companions.build.workspace={owner}"], capture_output=True, text=True)
        clean = clean and remaining.returncode == 0 and not remaining.stdout.strip()
    for handle in log_handles:
        handle.close()
    state.update(status="stopped" if clean else "failed", cleanup={"verified": clean}, services={})
    write_json(state_path, state)

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
run(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    postgres_name = f"companions-pg-{workspace}"
    if "DATABASE_URL" not in env:
        ensure_container(postgres_name, [
            "--publish", f"127.0.0.1:{base+2}:5432",
            "--env", "POSTGRES_USER=companions", "--env", "POSTGRES_PASSWORD=companions",
            "--env", "POSTGRES_DB=companions", "--volume", f"{postgres_name}:/var/lib/postgresql/data",
            POSTGRES_IMAGE,
        ])
        database_address = subprocess.check_output(["docker", "port", postgres_name, "5432/tcp"], text=True).strip()
        env["DATABASE_URL"] = f"postgres://companions:companions@{database_address}/companions"
        for _ in range(60):
            ready = subprocess.run(["docker", "exec", postgres_name, "pg_isready", "-h", "127.0.0.1", "-U", "companions"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise SystemExit("PostgreSQL did not become ready")

    minio_name = f"companions-minio-{workspace}"
    if "S3_ENDPOINT" not in env:
        credentials = service_credentials()
        ensure_container(minio_name, [
            "--publish", f"127.0.0.1:{base+3}:9000", "--publish", f"127.0.0.1:{base+4}:9001",
            "--env", f"MINIO_ROOT_USER={credentials['minioUser']}",
            "--env", f"MINIO_ROOT_PASSWORD={credentials['minioPassword']}",
            "--volume", f"{minio_name}:/data", MINIO_IMAGE,
            "server", "/data", "--console-address", ":9001",
        ])
        env.update({
            "S3_ENDPOINT": f"http://127.0.0.1:{base+3}",
            "S3_ACCESS_KEY_ID": credentials["minioUser"],
            "S3_SECRET_ACCESS_KEY": credentials["minioPassword"],
            "S3_BUCKET_FILES": "companions-files", "S3_REGION": "us-east-1",
        })
        wait_http(f"{env['S3_ENDPOINT']}/minio/health/live", "MinIO")
        run(["docker", "run", "--rm", "--network", f"container:{minio_name}",
             "--env", f"MC_HOST_local=http://{credentials['minioUser']}:{credentials['minioPassword']}@127.0.0.1:9000",
             MINIO_CLIENT_IMAGE, "mb", "--ignore-existing", f"local/{env['S3_BUCKET_FILES']}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    mailpit_name = f"companions-mailpit-{workspace}"
    if "SMTP_HOST" not in env:
        ensure_container(mailpit_name, [
            "--publish", f"127.0.0.1:{base+5}:1025", "--publish", f"127.0.0.1:{base+6}:8025",
            "--env", "MP_DATABASE=/data/mailpit.db", "--volume", f"{mailpit_name}:/data", MAILPIT_IMAGE,
        ])
        env.update({
            "SMTP_HOST": "127.0.0.1", "SMTP_PORT": str(base + 5),
            "SMTP_FROM": "companions.build <auth@companions.build>",
        })
        wait_http(f"http://127.0.0.1:{base+6}/livez", "Mailpit")

    prepare()
    run([bun, "apps/server/src/migrate.ts"])
    env["COMPANIONS_SCHEMA_PREPARED"] = "1"
    service_commands = {
        "api": ([bun, "apps/server/src/api.ts"], ROOT),
        "executor": ([bun, "apps/server/src/executor.ts"], ROOT),
        "worker": ([bun, "apps/server/src/worker.ts"], ROOT),
        "web": ([bun, "run", "dev", "--host", "127.0.0.1", "--port", env["WEB_PORT"]], ROOT / "apps/web"),
    }
    def start_services():
        for name, (args, cwd) in service_commands.items():
            handle = (logs / f"{name}.log").open("w")
            log_handles.append(handle)
            child = subprocess.Popen(bun_command(args), cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)
            children.append(child)
            state["services"][name] = {"pid": child.pid, "log": str(logs / f"{name}.log"),
                "identity": subprocess.check_output(["ps", "-p", str(child.pid), "-o", "lstart="], text=True).strip(),
                "command": subprocess.check_output(["ps", "-p", str(child.pid), "-o", "command="], text=True).strip()}
            write_json(state_path, state)
        wait_http(f"http://127.0.0.1:{env['API_PORT']}/health", "API")
        wait_http(f"http://127.0.0.1:{env['WEB_PORT']}", "Web")
        for _ in range(120):
            if all(child.poll() is None for child in children) and all(
                marker in (logs / f"{name}.log").read_text()
                for name, marker in [("executor", "Executor ready"), ("worker", "Worker ready")]
            ):
                return
            if any(child.poll() is not None for child in children):
                raise RuntimeError("A service exited during startup; see .local/logs")
            time.sleep(.25)
        raise RuntimeError("Executor/worker readiness timed out")

    start_services()
    endpoints = {"url": env["APP_URL"], "webPort": int(env["WEB_PORT"]), "apiPort": int(env["API_PORT"]),
                 "mailUrl": f"http://127.0.0.1:{base+6}", "basePort": base,
                 "testMode": env["AGENT_TEST_MODE"] == "1", "dataDir": str(data_dir), "workspace": workspace}
    write_json(data_dir / "dev-endpoints.json", endpoints)
    state.update(status="ready", url=env["APP_URL"], endpoints=endpoints)
    write_json(state_path, state)
    print(f"\nCompanions: {env['APP_URL']}\nSign in using the email link.", flush=True)
    if env.get("SMTP_HOST") == "127.0.0.1" and env.get("SMTP_PORT") == str(base + 5):
        print(f"Email: http://127.0.0.1:{base+6}", flush=True)
    print(flush=True)
    def watched_digest():
        from dev_support import digest
        return digest([*ROOT.glob("apps/server/src/**/*"), *ROOT.glob("packages/**/*"),
                       ROOT / "bun.lock", ROOT / "package.json", ROOT / "scripts/build-agent.ts", *ROOT.glob("scripts/lib/*")])
    observed = watched_digest()
    while all(child.poll() is None for child in children):
        time.sleep(1)
        if env.get("COMPANIONS_DEV_WATCH", "1") == "0":
            continue
        changed = watched_digest()
        if changed == observed:
            continue
        state["status"] = "restarting"
        write_json(state_path, state)
        # Stop admission before changing the runtime. Durable recovery belongs to the executor.
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        children.clear()
        for handle in log_handles:
            handle.close()
        log_handles.clear()
        try:
            prepare()
            run([bun, "apps/server/src/migrate.ts"])
            start_services()
            state["status"] = "ready"
        except (subprocess.CalledProcessError, RuntimeError, SystemExit):
            for child in children:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
            for child in children:
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            children.clear()
            state.update(status="build-failed", services={})
            print("Reload failed; watching for the next source edit. See .local/logs and dev-launch.log.", flush=True)
        write_json(state_path, state)
        observed = changed
    failed_code = next((child.returncode for child in children if child.returncode is not None), 1)
    raise SystemExit(failed_code or 1)
except KeyboardInterrupt:
    pass
finally:
    stop()
