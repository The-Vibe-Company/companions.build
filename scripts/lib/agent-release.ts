import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const AGENT_RELEASE_FILES = ["companion-agent", "photon_rs_bg.wasm", "package.json", "runtime-release.json", "launch-headless.py", "retire-legacy.py",
  "state-directory.py", "state-preflight.py", "update-runtime.py", "start-headless.sh", "headless-mounts.sh", "desktop-capture.py", "desktop-quiesce.py",
  "desktop-state.py", "configure-desktop.py", "install-desktop.sh"] as const;

export function calculateAgentReleaseDigest(directory: string) {
  const hash = createHash("sha256");
  for (const name of AGENT_RELEASE_FILES) hash.update(readFileSync(`${directory}/${name}`));
  return hash.digest("hex");
}
