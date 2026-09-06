"""Start an isolated local Companion stack. Ctrl-C stops processes and service containers."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time
import urllib.request
from bun import ROOT, module

os.chdir(ROOT)
env = os.environ.copy()
launcher_keys = {
    "WEB_PORT", "API_PORT", "DATABASE_URL", "COMPANIONS_DATA_DIR", "AGENT_TEST_MODE",
    "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_FILES", "S3_REGION",
    "SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD",
}
# Bun loads .env itself; the launcher also needs local-service and workspace settings.
if (ROOT / ".env").exists():
    for line in (ROOT / ".env").read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key in launcher_keys:
            env.setdefault(key, value.strip().strip('"').strip("'"))
workspace = hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
base = int(env.get("CONDUCTOR_PORT", env.get("WEB_PORT", str(4000 + int(workspace[:4], 16) % 2000 * 10))))
env.setdefault("WEB_PORT", str(base))
env.setdefault("API_PORT", str(base + 1))
env.setdefault("APP_URL", f"http://127.0.0.1:{base}")
env.setdefault("AGENT_TEST_MODE", "1")
env.setdefault("COMPANIONS_DATA_DIR", str(ROOT / ".local"))
data_dir = Path(env["COMPANIONS_DATA_DIR"])
if not data_dir.is_absolute():
    data_dir = ROOT / data_dir
data_dir.mkdir(parents=True, exist_ok=True)
data_dir.chmod(0o700)
bun = module.toolchain()
children = []
managed_containers = []

POSTGRES_IMAGE = "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
MINIO_IMAGE = "minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"
MINIO_CLIENT_IMAGE = "minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3"
MAILPIT_IMAGE = "axllent/mailpit:v1.27.8@sha256:6abc8e633df15eaf785cfcf38bae48e66f64beecdc03121e249d0f9ec15f0707"

def run(args, **kwargs):
    return subprocess.run(args, check=True, env=env, **kwargs)

def container(name):
    found = subprocess.run(["docker", "inspect", name], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return None if found.returncode else json.loads(found.stdout)[0]

def ensure_container(name, args):
    details = container(name)
    if details is None:
        run(["docker", "run", "--detach", "--name", name,
             "--label", f"companions.build.workspace={workspace}", *args], stdout=subprocess.DEVNULL)
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
    if managed_containers:
        subprocess.run(["docker", "stop", "--time", "3", *reversed(managed_containers)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

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
            ready = subprocess.run(["docker", "exec", postgres_name, "pg_isready", "-U", "companions"],
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

    run([bun, "install", "--frozen-lockfile"])
    run([bun, "install", "--frozen-lockfile"], cwd=ROOT / "apps/web")
    run([bun, "scripts/build-agent.ts"])
    for args, cwd in [([bun, "apps/server/src/api.ts"], ROOT), ([bun, "apps/server/src/executor.ts"], ROOT),
                      ([bun, "run", "dev", "--host", "127.0.0.1", "--port", str(base)], ROOT / "apps/web")]:
        children.append(subprocess.Popen(args, cwd=cwd, env=env, start_new_session=True))
    print(f"\nCompanions: http://127.0.0.1:{base}\nAccess token: read {env['COMPANIONS_DATA_DIR']}/operator-token", flush=True)
    if env.get("SMTP_HOST") == "127.0.0.1" and env.get("SMTP_PORT") == str(base + 5):
        print(f"Email: http://127.0.0.1:{base+6}", flush=True)
    print(flush=True)
    while all(child.poll() is None for child in children):
        time.sleep(0.5)
    failed_code = next((child.returncode for child in children if child.returncode is not None), 1)
    raise SystemExit(failed_code or 1)
except KeyboardInterrupt:
    pass
finally:
    stop()
