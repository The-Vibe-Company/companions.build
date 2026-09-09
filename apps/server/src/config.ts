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
function authSecret() {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  if (process.env.NODE_ENV === "production") throw new Error("BETTER_AUTH_SECRET is required in production");
  return localSecret("auth-secret");
}
function authUrl() {
  const value = process.env.BETTER_AUTH_URL ?? process.env.APP_URL;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("BETTER_AUTH_URL or APP_URL is required in production");
  return `http://127.0.0.1:${process.env.WEB_PORT ?? 4310}`;
}
function modelGatewayUrl(){
 if(process.env.AGENT_TEST_MODE==='1')return undefined;
 const configured=process.env.MODEL_GATEWAY_URL;
 // Direct credentials are a developer-only path. Hosted clients always use the gateway.
 const value=configured??(process.env.NODE_ENV==='production'?`${authUrl().replace(/\/$/,'')}/api/model-gateway`:undefined);
 if(!value)return undefined;
 const url=new URL(value);
 const local=['localhost','127.0.0.1','host.docker.internal'].includes(url.hostname);
 if((url.protocol!=='https:'&&!(process.env.NODE_ENV!=='production'&&local&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash||url.pathname!=='/api/model-gateway')throw Error('MODEL_GATEWAY_URL_INVALID');
 return url.toString().replace(/\/$/,'');
}
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://companions:companions@127.0.0.1:4312/companions",
  token: localSecret("operator-token", process.env.COMPANIONS_TOKEN),
  authSecret: authSecret(),
  authUrl: authUrl(),
  localDevEmail: process.env.LOCAL_DEV_EMAIL ?? "developer@companions.build",
  smtpHost: process.env.SMTP_HOST,
  smtpPort: Number(process.env.SMTP_PORT ?? 25),
  smtpSecure: process.env.SMTP_SECURE === "1",
  smtpUser: process.env.SMTP_USER,
  smtpPassword: process.env.SMTP_PASSWORD,
  emailProvider: process.env.EMAIL_PROVIDER,
  emailFrom: process.env.EMAIL_FROM ?? process.env.SMTP_FROM ?? "companions.build <auth@companions.build>",
  resendApiKey: process.env.RESEND_API_KEY,
  encryptionKey: localSecret("encryption-key", process.env.COMPANIONS_ENCRYPTION_KEY),
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.API_PORT ?? process.env.PORT ?? 4311),
  webDist: process.env.WEB_DIST,
  boxKey: process.env.BOX_API_KEY ?? process.env.COMPANION_BOX_API_KEY,
  boxTemplate: process.env.BOX_TEMPLATE,
  // Consuming managed images does not grant permission to mutate shared Box snapshots.
  managedBoxTemplate: process.env.BOX_MANAGED_TEMPLATE === '1' || (process.env.NODE_ENV === 'production' && process.env.BOX_MANAGED_TEMPLATE !== '0'),
  publishManagedBoxTemplate: process.env.NODE_ENV === 'production' && process.env.COMPANIONS_DEV_LOCAL !== '1' && process.env.BOX_MANAGED_TEMPLATE_PUBLISH === '1',
  modelProvider: process.env.MODEL_PROVIDER ?? "google",
  modelId: process.env.MODEL_ID ?? "gemini-2.5-flash",
  modelGatewayUrl:modelGatewayUrl(),
  testMode: process.env.AGENT_TEST_MODE === "1",
  localAvailable: process.env.LOCAL_RUNTIME === "1",
  defaultProvider: process.env.LOCAL_RUNTIME === "1" ? "local" as const : "box" as const,
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
