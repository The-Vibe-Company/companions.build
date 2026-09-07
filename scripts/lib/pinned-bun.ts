import { readFileSync } from "node:fs";

/** Refuse an unpinned compiler before creating a distribution or touching Box. */
export function requirePinnedBun() {
  const { packageManager } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  if (packageManager !== `bun@${Bun.version}`) {
    throw new Error("Use the pinned toolchain: python3 scripts/bun.py <script>.");
  }
}
