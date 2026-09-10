#!/usr/bin/env python3
"""Paired compiled daemon creation/wake measurement, always inside owned Docker Linux."""
import argparse
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def percentile(values, fraction=.95):
    return sorted(values)[min(len(values) - 1, int(len(values) * fraction))]


def request(port, route, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{route}", data=data,
        method="GET" if body is None else "PUT", headers={"Authorization": "Bearer fixture-only", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=1) as response:
        return json.load(response)


def sample(binary, state):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    started = time.perf_counter()
    child = subprocess.Popen([str(binary)], env={"AGENT_TOKEN": "fixture-only", "AGENT_TEST_MODE": "1",
        "AGENT_STATE_DIR": str(state), "PORT": str(port), "HOME": str(state)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                request(port, "/health")
                break
            except (OSError, urllib.error.URLError):
                if child.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("MEMORY_BENCHMARK_STARTUP_FAILED")
                time.sleep(.002)
        ready = time.perf_counter()
        run_id = str(uuid.uuid4())
        request(port, f"/runs/{run_id}", {"content": "hello", "instructions": ""})
        while True:
            result = request(port, f"/runs/{run_id}")
            if result["status"] not in ("running", "needs_input"):
                if result["status"] != "succeeded" or result["text"] != "Scripted response.":
                    raise RuntimeError("MEMORY_BENCHMARK_RESPONSE_FAILED")
                break
            if time.monotonic() > deadline:
                raise RuntimeError("MEMORY_BENCHMARK_RESPONSE_TIMEOUT")
            time.sleep(.002)
        done = time.perf_counter()
        return {"readyMs": (ready-started)*1000, "responseMs": (done-ready)*1000, "firstResponseMs": (done-started)*1000}
    finally:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait()


def populate(binary, state):
    requests = []
    for index in range(100):
        requests.append({"id": str(index), "authority": "human", "request": {"op": "save", "operationId": f"fixture-{index}",
            "scope": "user" if index < 5 else "project", "kind": "preference" if index < 5 else "fact",
            "content": "Use concise summaries " + ("durable project fact " * 25), "provenance": "synthetic benchmark",
            **({"projectKey": "fixture"} if index >= 5 else {})}})
    result = subprocess.run([str(binary), "--memory-worker", str(state)], input="".join(json.dumps(item)+"\n" for item in requests),
        text=True, capture_output=True, check=True, timeout=30, env={})
    replies = [json.loads(line)["response"] for line in result.stdout.splitlines()]
    if len(replies) != 100 or any(item["status"] != "ok" for item in replies):
        raise RuntimeError("MEMORY_BENCHMARK_POPULATION_FAILED")


def inside(samples):
    rows = []
    with tempfile.TemporaryDirectory(prefix="memory-latency-") as directory:
        for iteration in range(samples):
            # Alternate order to reduce systematic warm-cache/scheduling bias.
            for variant in (["baseline", "candidate"] if iteration % 2 == 0 else ["candidate", "baseline"]):
                state = pathlib.Path(directory) / f"{iteration}-{variant}"
                state.mkdir()
                binary = pathlib.Path("/" + variant) / "companion-agent"
                rows.append({"sample": iteration, "variant": variant, "phase": "create", **sample(binary, state)})
                (state / "workspace" / "MEMORY.md").write_text("legacy project context " * 1000)
                populate(binary, state)
                rows.append({"sample": iteration, "variant": variant, "phase": "wake", **sample(binary, state)})
    summary = {}
    for phase in ("create", "wake"):
        values = {variant: {metric: percentile([r[metric] for r in rows if r["variant"] == variant and r["phase"] == phase])
            for metric in ("readyMs", "responseMs", "firstResponseMs")} for variant in ("baseline", "candidate")}
        values["addedP95FirstResponseMs"] = values["candidate"]["firstResponseMs"] - values["baseline"]["firstResponseMs"]
        summary[phase] = values
    return {"samplesPerVariantPhase": samples, "summary": summary, "samples": rows,
        "passed": all(summary[phase]["addedP95FirstResponseMs"] <= 50 for phase in summary),
        "limitations": "Compiled scripted daemon in Linux x86_64 Docker, 2ms polling; excludes Docker/Box provisioning, network and real model latency. Both wake variants retain Pi transcript, legacy MEMORY.md and 100 memory records."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=pathlib.Path)
    parser.add_argument("--candidate", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--inside", action="store_true")
    args = parser.parse_args()
    if args.samples < 30:
        parser.error("At least 30 samples are required")
    if args.inside:
        result = inside(args.samples)
        print(json.dumps(result))
    else:
        if not args.baseline or not args.candidate or not args.output:
            parser.error("--baseline, --candidate and --output are required")
        name = "the635-memory-latency-" + str(uuid.uuid4())
        try:
            run = subprocess.run(["docker", "run", "--rm", "--init", "--name", name, "--network", "none",
                "--label", "companions.build.test=memory-latency", "--platform", "linux/amd64",
                "--mount", f"type=bind,src={args.baseline.resolve()},dst=/baseline,readonly",
                "--mount", f"type=bind,src={args.candidate.resolve()},dst=/candidate,readonly",
                "--mount", f"type=bind,src={pathlib.Path(__file__).resolve()},dst=/test.py,readonly",
                "python:3.12-slim", "python3", "/test.py", "--inside", "--samples", str(args.samples)], capture_output=True, text=True, timeout=600)
            if run.returncode:
                raise RuntimeError("MEMORY_BENCHMARK_FAILED: " + run.stderr[-2000:])
            result = json.loads(run.stdout)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, indent=2)+"\n")
            print(json.dumps({"summary": result["summary"], "passed": result["passed"], "output": str(args.output)}, indent=2))
            if not result["passed"]:
                raise SystemExit(1)
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
            observed = subprocess.run(["docker", "ps", "-aq", "--filter", "name=^/"+name+"$"], capture_output=True, text=True, check=True)
            if observed.stdout.strip():
                raise RuntimeError("MEMORY_BENCHMARK_CLEANUP_FAILED")
