const image = "oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const result = Bun.spawnSync([
  "docker", "run", "--rm",
  "--env", "SOURCE_SERVICE_TOKEN=SOURCE_CREDENTIAL_SENTINEL_95c98a",
  "--mount", `type=bind,src=${root},dst=/workspace,readonly`,
  image, "sh", "-lc",
  "apt-get update >/dev/null && apt-get install -y --no-install-recommends npm >/dev/null && cd /workspace && bun test packages/box/software-install.linux.test.ts",
], { stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode);
