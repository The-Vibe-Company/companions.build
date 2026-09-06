import { timingSafeEqual, createHmac } from "node:crypto";
import { z } from "zod";
import { config } from "./config";
import { db, migrate, listCompanions, createCompanion, detail, acceptMessage, cancel, Conflict } from "./store";
import { BoxClient } from "../../../packages/box/client";

const idSchema = z.string().uuid();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
const sessionToken = () => createHmac("sha256", config.token).update("companions-operator-session-v1").digest("hex");
function authorized(request: Request) {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const cookie = request.headers.get("cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith("companions_session="))?.slice(19) ?? "";
  return equal(bearer, config.token) || equal(cookie, sessionToken());
}
export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true });
  // Reject cross-origin browser writes, including login. Vite forwards same origin.
  const origin = request.headers.get("origin");
  if (origin && ![url.origin, process.env.APP_URL ?? "http://127.0.0.1:4310", `http://localhost:${process.env.WEB_PORT ?? 4310}`].includes(origin)) return json({ error: "Origin not allowed." }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > 100_000) return json({ error: "Request too large." }, 413);
  try {
    if (request.method === "POST" && url.pathname === "/api/session") {
      const body = z.object({ token: z.string().max(256) }).parse(await request.json());
      if (!equal(body.token, config.token)) return json({ error: "Invalid access token." }, 401);
      return json({ ok: true }, 200, { "Set-Cookie": `companions_session=${sessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${url.protocol === "https:" ? "; Secure" : ""}` });
    }
    if (!authorized(request)) return json({ error: "Enter your workspace access token." }, 401);
    if (request.method === "GET" && url.pathname === "/api/config") return json({ localAvailable: config.localAvailable, boxAvailable: !!(config.boxKey && config.boxTemplate), model: config.testMode ? "Local test model" : `${config.modelProvider}/${config.modelId}` });
    if (url.pathname === "/api/companions") {
      if (request.method === "GET") return json({ companions: await listCompanions() });
      if (request.method === "POST") {
        const input = z.object({ name: z.string().trim().min(1).max(80), instructions: z.string().max(20_000).default(""), provider: z.enum(["local", "box"]) }).parse(await request.json());
        if (input.provider === "box" && (!config.boxKey || !config.boxTemplate)) return json({ error: "Box needs an API key and a prepared template." }, 409);
        if (input.provider === "local" && !config.localAvailable) return json({ error: "Local runtime is disabled." }, 409);
        return json({ companion: await createCompanion(input) }, 201);
      }
    }
    const match = url.pathname.match(/^\/api\/companions\/([^/]+)(?:\/(messages|cancel|desktop))?$/);
    if (match) {
      const id = idSchema.parse(match[1]);
      if (!match[2] && request.method === "GET") { const result = await detail(id); return result ? json(result) : json({ error: "Companion not found." }, 404); }
      if (match[2] === "messages" && request.method === "POST") {
        const body = z.object({ clientMessageId: idSchema, content: z.string().trim().min(1).max(50_000) }).parse(await request.json());
        const runId = await acceptMessage(id, body.clientMessageId, body.content);
        return runId ? json({ runId }, 202) : json({ error: "Companion not found." }, 404);
      }
      if (match[2] === "cancel" && request.method === "POST") return await cancel(id) ? json({ ok: true }) : json({ error: "Companion not found." }, 404);
      if (match[2] === "desktop" && request.method === "POST") {
        const [row] = await db`SELECT box_id,status FROM companions WHERE id=${id} AND provider='box'`;
        if (!row || row.status !== "ready" || !config.boxKey) return json({ error: "Send a message first to prepare this Box." }, 409);
        // V0 desktop viewing only; explicit GUI takeover is a later ticket.
        return json({ url: await new BoxClient(config.boxKey).desktop(row.box_id) });
      }
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid request." }, 400);
    if (error instanceof Conflict) return json({ error: error.message }, 409);
    console.error("api_request_failed");
    return json({ error: "The request could not be completed. Please try again." }, 500);
  }
}
if (import.meta.main) {
  await migrate();
  Bun.serve({ hostname: "127.0.0.1", port: config.port, maxRequestBodySize: 100_000, fetch: handler });
  console.log(`API ready at http://127.0.0.1:${config.port}`);
}
