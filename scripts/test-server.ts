import { SQL } from "bun";
import { config } from "../apps/server/src/config";
import { resolve } from "node:path";
const admin = new SQL(config.databaseUrl);
const name = `companions_test_${crypto.randomUUID().replaceAll("-", "")}`;
await admin.unsafe(`CREATE DATABASE "${name}"`);
try {
  const url = new URL(config.databaseUrl); url.pathname = `/${name}`;
  const child = Bun.spawn([process.execPath, "test", "apps/server/test"], { env: { ...process.env, DATABASE_URL: url.href,
    COMPANIONS_DATA_DIR: resolve(`.artifacts/system-tests/${name}`), AGENT_TEST_MODE: "1",
    RUN_LOCAL_ACCEPTANCE: process.argv.includes("--linux") ? "1" : "0",
    RUN_STORAGE_ACCEPTANCE: process.argv.includes("--linux") ? "1" : "0" }, stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} finally {
  await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.close();
}
