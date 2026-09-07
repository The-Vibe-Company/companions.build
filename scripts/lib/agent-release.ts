import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../../packages/box/software-distribution";

export const AGENT_RELEASE_FILES = ["companion-agent", "photon_rs_bg.wasm", "package.json", "launch-headless.py", "retire-legacy.py",
  "state-directory.py", "state-preflight.py", "start-headless.sh", "headless-mounts.sh", "desktop-capture.py", "desktop-quiesce.py",
  "desktop-state.py", "configure-desktop.py", "install-desktop.sh"] as const;

export function calculateAgentReleaseDigest(directory: string, software?: { builder: Uint8Array; descriptorPayload: unknown; keyring: Uint8Array }) {
  const hash = createHash("sha256");
  for (const name of AGENT_RELEASE_FILES) hash.update(readFileSync(`${directory}/${name}`));
  if (software) hash.update(software.builder).update(canonicalJson(software.descriptorPayload)).update(software.keyring);
  return hash.digest("hex");
}
