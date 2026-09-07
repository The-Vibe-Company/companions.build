"""Run the public signed Ubuntu snapshot proof in an isolated pinned Linux container."""
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517"
SNAPSHOT = "20240423T230000Z"
INRELEASE_SHA256 = "b82f6477958d5470e2d77ffaaa16b8ef84015f811929775529eea8c1669ae512"
KEYRING_SHA256 = "80a36b0a6de2f69f49d2df75ef473ccde121e9e190b9ea01d20a4f63778d5c31"

with tempfile.TemporaryDirectory(prefix="companions-apt-canary-") as temporary:
    dockerfile = Path(temporary) / "Dockerfile"
    dockerfile.write_text(f"""# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS bun
FROM {IMAGE}
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
""")
    tag = "companions-portable-apt-canary:20240423"
    subprocess.run(["docker", "build", "--platform", "linux/amd64", "--tag", tag, temporary], check=True)
    environment = {
        "COMPANIONS_SOFTWARE_BUILDER": "1",
        "APT_CANARY_PACKAGE": "hello",
        "APT_CANARY_VERSION": "2.10-3build1",
        "APT_SNAPSHOT_ORIGIN": f"https://snapshot.ubuntu.com/ubuntu/{SNAPSHOT}",
        "APT_SNAPSHOT_ID": SNAPSHOT,
        "APT_SNAPSHOT_COMPONENTS": "main,universe",
        "APT_SNAPSHOT_KEYRING": "/usr/share/keyrings/ubuntu-archive-keyring.gpg",
        "APT_CANARY_KEYRING_SHA256": KEYRING_SHA256,
        "APT_SNAPSHOT_INRELEASE_SHA256": INRELEASE_SHA256,
        "APT_CANARY_BASE_ID": "ubuntu-24.04.4-container-amd64",
        "APT_CANARY_DISTRIBUTION_DIGEST": IMAGE.split("sha256:", 1)[1],
        "APT_CANARY_BINARY": "/usr/bin/hello",
        "APT_CANARY_EXPECTED": "hello",
    }
    command = ["docker", "run", "--rm", "--platform", "linux/amd64", "--mount", f"type=bind,src={ROOT},dst=/workspace,readonly"]
    for key, value in environment.items(): command.extend(["--env", f"{key}={value}"])
    command.extend([tag, "bun", "/workspace/scripts/test-portable-apt-snapshot.ts"])
    completed = subprocess.run(command, text=True, capture_output=True)
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "APT canary failed")
    proof = json.loads(completed.stdout.strip().splitlines()[-1])
    print(json.dumps(proof, sort_keys=True))
