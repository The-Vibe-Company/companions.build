"""Small stable entrypoint for focused repository validation."""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Run a focused check with isolated dependencies")
    parser.add_argument("profile", choices=("web", "server", "agent", "full"))
    parser.add_argument("--test", help="substring selecting server test files")
    args = parser.parse_args(argv)
    if args.test and args.profile not in ("server", "full"):
        parser.error("--test is only valid for server and full checks")
    return args


def command_for(args):
    command = [sys.executable, str(ROOT / "scripts/verify.py"), "--profile", args.profile]
    if args.test:
        command.extend(["--test", args.test])
    return command


def main(argv=None):
    args = parse_args(argv)
    return subprocess.run(command_for(args), cwd=ROOT).returncode


if __name__ == "__main__":
    raise SystemExit(main())
