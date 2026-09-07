import { SQL } from "bun";
import { config } from "../apps/server/src/config";
import { resolve } from "node:path";
const admin = new SQL(config.databaseUrl);
const fromFile=process.argv.find(value=>value.startsWith('--from-file='))?.slice('--from-file='.length);
// Every suite owns its database. Lifecycle progression must never see another fixture's intents.
try {
 const files=[...new Bun.Glob('*.test.ts').scanSync('apps/server/test')].sort();
 if(fromFile&&!files.includes(fromFile))throw Error('Unknown server test file.');
 for(const file of files.filter(file=>!fromFile||file>=fromFile)){
  const name = `companions_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  try {
   const url = new URL(config.databaseUrl); url.pathname = `/${name}`;
   const child = Bun.spawn([process.execPath, "test", `apps/server/test/${file}`], { env: { ...process.env, DATABASE_URL: url.href,
    COMPANIONS_DATA_DIR: resolve(`.artifacts/system-tests/${name}`), AGENT_TEST_MODE: "1",
    RUN_LOCAL_ACCEPTANCE: process.argv.includes("--linux") ? "1" : "0" }, stdout: "inherit", stderr: "inherit" });
   const code=await child.exited;if(code)process.exitCode=code;
  } finally {await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);}
 }
} finally {await admin.close();}
