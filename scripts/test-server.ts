import { SQL } from "bun";
import { config } from "../apps/server/src/config";
import { resolve } from "node:path";
const admin = new SQL(config.databaseUrl);
const testFlag = process.argv.indexOf("--test");
if (testFlag >= 0 && !process.argv[testFlag + 1]) throw new Error("--test requires a pattern");
const testPattern = testFlag >= 0 ? process.argv[testFlag + 1]!.toLowerCase() : undefined;
const files = [...new Bun.Glob('*.test.ts').scanSync('apps/server/test')]
 .sort()
 .filter(file => !testPattern || file.toLowerCase().includes(testPattern));
if (!files.length) throw new Error(`No server test file matches ${JSON.stringify(testPattern)}`);
// Every suite owns its database. Lifecycle progression must never see another fixture's intents.
try {
 for(const file of files){
  const name = `companions_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  try {
   const url = new URL(config.databaseUrl); url.pathname = `/${name}`;
   const child = Bun.spawn([process.execPath, "--no-env-file", "test", `apps/server/test/${file}`], { env: { ...process.env, DATABASE_URL: url.href,
    COMPANIONS_DATA_DIR: resolve(`.artifacts/system-tests/${name}`), AGENT_TEST_MODE: "1", LOCAL_RUNTIME: "1",
    RUN_LOCAL_ACCEPTANCE: process.argv.includes("--linux") ? "1" : "0" }, stdout: "inherit", stderr: "inherit" });
   const code=await child.exited;if(code)process.exitCode=code;
  } finally {await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);}
 }
} finally {await admin.close();}
