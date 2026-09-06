"""Run the repository's checksum-verified Bun, without replacing your global runtime."""
import importlib.util
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("probe_toolchain", ROOT / "experiments/pi-bun/verify.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

if __name__ == "__main__":
    os.chdir(ROOT)
    executable = module.toolchain()
    os.execv(executable, [executable, *sys.argv[1:]])
