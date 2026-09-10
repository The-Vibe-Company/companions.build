#!/usr/bin/env python3
"""Isolated data-only compatibility probe; does not launch agent shell tools."""
import argparse
import json
import pathlib
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--package-dir", type=pathlib.Path, required=True)
args = parser.parse_args()
package = args.package_dir.resolve()
version = json.loads((package / "package.json").read_text())["version"]
if version != "0.9.8":
    raise SystemExit("This evaluation is pinned to pi-hermes-memory 0.9.8")

with tempfile.TemporaryDirectory(prefix="the635-hermes-") as directory:
    root = pathlib.Path(directory)
    source = root / "probe.ts"
    source.write_text('''import { DatabaseManager } from ''' + json.dumps(str(package / "src/store/db.ts")) + ''';
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir=mkdtempSync(join(tmpdir(),"the635-hermes-db-"));
let manager=new DatabaseManager(dir);
try {
 const started=performance.now();
 manager.getDb().prepare("INSERT INTO memories (target, content, created, last_referenced) VALUES (?, ?, ?, ?)")
   .run("user","prefers concise summaries","2026-09-10","2026-09-10");
 manager.close(); manager=new DatabaseManager(dir);
 const rows=manager.getDb().prepare("SELECT content FROM memory_fts WHERE memory_fts MATCH ?").all("concise");
 if(rows.length!==1) throw Error("SEARCH_OR_PERSISTENCE_FAILED");
 console.log(JSON.stringify({bun:Bun.version,openWriteReopenSearchMs:performance.now()-started,matchCount:rows.length}));
} finally { manager.close(); rmSync(dir,{recursive:true,force:true}); }
''')
    results = {"package": "pi-hermes-memory@" + version}
    source_run = subprocess.run(["bun", "--no-env-file", str(source)], cwd=root, check=True, capture_output=True, text=True)
    results["source"] = json.loads(source_run.stdout)
    subprocess.run(["bun", "build", "--compile", "--target=bun-linux-x64-baseline", str(source), "--outfile", str(root / "probe")], check=True, capture_output=True)
    compiled = subprocess.run([str(root / "probe")], cwd=root, check=True, capture_output=True, text=True)
    results["compiled"] = json.loads(compiled.stdout)
    results["limitations"] = "Data-only probe: does not prove extension lifecycle, Pi integration, creation/wake latency, or container acceptance."
    print(json.dumps(results, indent=2))
