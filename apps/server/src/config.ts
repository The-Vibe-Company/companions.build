import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export const dataDir = resolve(process.env.COMPANIONS_DATA_DIR ?? ".local");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
function localSecret(name: string, env?: string) {
  if (env) return env;
  const path = join(dataDir, name);
  try { return readFileSync(path, "utf8").trim(); } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    try { writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
    return readFileSync(path, "utf8").trim();
  }
}
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://companions:companions@127.0.0.1:4312/companions",
  token: localSecret("operator-token", process.env.COMPANIONS_TOKEN),
  encryptionKey: localSecret("encryption-key", process.env.COMPANIONS_ENCRYPTION_KEY),
  port: Number(process.env.API_PORT ?? 4311),
  boxKey: process.env.BOX_API_KEY ?? process.env.COMPANION_BOX_API_KEY,
  boxTemplate: process.env.BOX_TEMPLATE,
  modelProvider: process.env.MODEL_PROVIDER ?? "google",
  modelId: process.env.MODEL_ID ?? "gemini-2.5-flash",
  testMode: process.env.AGENT_TEST_MODE === "1",
  localAvailable: process.env.LOCAL_RUNTIME !== "0",
};
if (!/^[0-9a-f]{64}$/i.test(config.encryptionKey)) throw new Error("COMPANIONS_ENCRYPTION_KEY must be 32 bytes encoded as hex");
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.encryptionKey, "hex"), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
export function decrypt(value: string) {
  const bytes = Buffer.from(value, "base64");
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(config.encryptionKey, "hex"), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
}
