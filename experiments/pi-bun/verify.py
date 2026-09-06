"""One command: pinned toolchain, Linux build, behavioral checks and retained evidence."""
import argparse
import datetime
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
BUN_VERSION = "1.4.2"
# Release digests: https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2
TOOLCHAINS = {
    ("Darwin", "arm64"): ("bun-darwin-aarch64", "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f"),
    ("Darwin", "x86_64"): ("bun-darwin-x64", "80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012"),
    ("Linux", "x86_64"): ("bun-linux-x64-baseline", "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f"),
    ("Linux", "aarch64"): ("bun-linux-aarch64", "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7"),
}

def toolchain():
    asset, digest = TOOLCHAINS[(platform.system(), platform.machine())]
    directory = ROOT / ".artifacts/toolchain" / f"bun-{BUN_VERSION}-{asset}"
    archive = directory / "download.zip"
    directory.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        url = f"https://github.com/oven-sh/bun/releases/download/bun-v{BUN_VERSION}/{asset}.zip"
        print(f"Downloading pinned Bun {BUN_VERSION} into .artifacts/toolchain", flush=True)
        data = urllib.request.urlopen(url, timeout=60).read()
    else:
        data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"Bun checksum mismatch; remove {archive} and rerun")
    archive.write_bytes(data)
    executable = directory / "bun"
    # Re-extract the checked bytes; do not trust an old executable in the cache.
    executable.write_bytes(zipfile.ZipFile(io.BytesIO(data)).read(f"{asset}/bun"))
    executable.chmod(0o755)
    return str(executable)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", help="Bun test name regex; omit for the full verification")
    parser.add_argument("--acceptance-timeout", type=float, default=240, help="Seconds before stopping test processes and their owned containers")
    args = parser.parse_args()
    os.chdir(ROOT)
    evidence_root = ROOT / ".artifacts/pi-bun"
    evidence_root.mkdir(parents=True, exist_ok=True)
    lock = (evidence_root / "verify.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("A verification already owns this workspace; use another worktree or wait for it to finish.")
    run_id = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    evidence = evidence_root / run_id
    evidence.mkdir()
    env = os.environ.copy()
    env["PROBE_ARTIFACTS"] = str(evidence)
    env["PROBE_RUN_ID"] = run_id
    env["PROBE_IMAGE"] = "companions-build-probe:" + hashlib.sha256(str(ROOT).encode()).hexdigest()[:12]
    summary = {"status": "running", "run": run_id, "scenario": args.scenario,
               "host": {"system": platform.system(), "arch": platform.machine(), "release": platform.release()},
               "bun": BUN_VERSION, "target": "linux-x64-baseline", "steps": []}
    started = time.monotonic()

    def run(name, command, timeout=300):
        log = evidence / f"{name}.log"
        print(f"[{name}] {log.relative_to(ROOT)}", flush=True)
        step = {"name": name, "command": command, "log": str(log.relative_to(ROOT))}
        summary["steps"].append(step)
        before = time.monotonic()
        with log.open("w") as output:
            proc = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, env=env, start_new_session=True)
            try:
                code = proc.wait(timeout=timeout)
            except BaseException:
                os.killpg(proc.pid, signal.SIGTERM)
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                raise
        step.update(exitCode=code, durationSeconds=round(time.monotonic() - before, 3))
        if code:
            print(log.read_text()[-12000:], file=sys.stderr)
            raise RuntimeError(f"{name} failed (exit {code}); see {log}")

    try:
        if not shutil.which("docker"):
            raise RuntimeError("Docker CLI is missing. Install Docker, start its engine, then rerun this command.")
        run("doctor", ["docker", "version"], timeout=20)
        bun = toolchain()
        run("install", [bun, "install", "--frozen-lockfile", "--ignore-scripts"])
        run("typecheck", [bun, "node_modules/typescript/bin/tsc"])
        run("build", [bun, "experiments/pi-bun/build.ts"])
        run("linux-image", ["docker", "build", "--platform", "linux/amd64", "-t", env["PROBE_IMAGE"],
                            "-f", "experiments/pi-bun/Dockerfile", "experiments/pi-bun"])
        run("linux-environment", ["docker", "run", "--rm", "--network=none", "--platform", "linux/amd64",
                                  env["PROBE_IMAGE"], "sh", "-c", "uname -a; cat /etc/os-release; ldd --version"])
        inventory = [{"path": str(p.relative_to(ROOT / "dist/pi-bun")), "bytes": p.stat().st_size,
                      "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                     for p in sorted((ROOT / "dist/pi-bun").rglob("*")) if p.is_file()]
        (evidence / "distribution.json").write_text(json.dumps(inventory, indent=2) + "\n")
        with tarfile.open(evidence / "pi-bun-linux-x64.tar.gz", "w:gz") as archive:
            archive.add(ROOT / "dist/pi-bun", arcname="pi-bun")
        command = [bun, "test", "experiments/pi-bun/acceptance.test.ts", "--reporter=junit", f"--reporter-outfile={evidence / 'tests.xml'}"]
        if args.scenario:
            command += ["--test-name-pattern", args.scenario]
        run("acceptance", command, timeout=args.acceptance_timeout)
        cases = ET.parse(evidence / "tests.xml").getroot().findall(".//testcase")
        executed = [case for case in cases if case.find("skipped") is None]
        if not executed or (not args.scenario and (len(executed) < 11 or len(executed) != len(cases))):
            raise RuntimeError("Incomplete evidence: no tests ran or the full suite skipped required cases")
        summary["testsExecuted"] = len(executed)
        summary["status"] = "passed"
    except (Exception, KeyboardInterrupt) as error:
        summary.update(status="failed", error=str(error))
        print(str(error), file=sys.stderr)
    finally:
        # Docker containers outlive their CLI client; clean only this exact run.
        try:
            listed = subprocess.run(["docker", "ps", "-aq", "--filter", f"label=companions.build.probe.run={run_id}"],
                                    capture_output=True, text=True, timeout=20, check=True)
            containers = listed.stdout.split()
            if containers:
                subprocess.run(["docker", "rm", "-f", *containers], capture_output=True, timeout=30, check=True)
            summary["containerCleanup"] = "complete"
        except Exception as error:
            summary.update(status="failed", cleanupError=str(error))
        summary["durationSeconds"] = round(time.monotonic() - started, 3)
        (evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        (evidence_root / "latest.json").write_text(json.dumps({"directory": str(evidence), "status": summary["status"]}) + "\n")
        print(f"{summary['status'].upper()}: {evidence}\nReproduce: python3 experiments/pi-bun/verify.py", flush=True)
    return 0 if summary["status"] == "passed" else 1

if __name__ == "__main__":
    sys.exit(main())
