import { z } from "zod";
import { config } from "./config";
import { db, migrate, listCompanions, createCompanion, detail, acceptMessage, cancel, Conflict } from "./store";
import { BoxClient, BoxError } from "../../../packages/box/client";
import { auth, AuthenticationRequired, requireUser, sessionUser } from "./auth";

import { handlePlugins, PluginError } from "./plugins";
import { handleFiles, filesForThread, FILE_REQUEST_MAX_BYTES } from "./files";
import { handleAutomations } from "./automation-routes";
import { avatarSchema, configureCompanion } from "./control";

const idSchema = z.string().uuid();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true });
  // Reject cross-origin browser writes, including login. Vite forwards same origin.
  const origin = request.headers.get("origin");
  if (origin && ![url.origin, process.env.APP_URL ?? "http://127.0.0.1:4310", `http://localhost:${process.env.WEB_PORT ?? 4310}`].includes(origin)) return json({ error: "Origin not allowed." }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > (url.pathname.endsWith("/files") ? FILE_REQUEST_MAX_BYTES : 100_000)) return json({ error: "Request too large." }, 413);
  try {
    if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
    if (request.method === "GET" && url.pathname === "/api/me") {
      const user = await sessionUser(request);
      return user ? json({ user: { id: user.id, email: user.email, name: user.name } }) : json({ error: "Authentication required." }, 401);
    }
    const ownerId = await requireUser(request);
    const fileResponse = await handleFiles(request,ownerId);
    if(fileResponse) return fileResponse;
    const automationResponse = await handleAutomations(request,ownerId);
    if(automationResponse) return automationResponse;
    const pluginResponse = await handlePlugins(request,ownerId);
    if(pluginResponse) return pluginResponse;
    if (request.method === "GET" && url.pathname === "/api/config") return json({ localAvailable: config.localAvailable, boxAvailable: !!(config.boxKey && config.boxTemplate), model: config.testMode ? "Local test model" : `${config.modelProvider}/${config.modelId}` });
    if (url.pathname === "/api/companions") {
      if (request.method === "GET") return json({ companions: await listCompanions(ownerId) });
      if (request.method === "POST") {
        const input = z.object({ name: z.string().trim().min(1).max(80), instructions: z.string().max(20_000).default(""), provider: z.enum(["local", "box"]), avatar: avatarSchema.optional() }).parse(await request.json());
        if (input.provider === "box" && (!config.boxKey || !config.boxTemplate)) return json({ error: "Box needs an API key and a prepared template." }, 409);
        if (input.provider === "local" && !config.localAvailable) return json({ error: "Local runtime is disabled." }, 409);
        return json({ companion: await createCompanion(ownerId, input) }, 201);
      }
    }
    const match = url.pathname.match(/^\/api\/companions\/([^/]+)(?:\/(messages|cancel|desktop))?$/);
    if (match) {
      const id = idSchema.parse(match[1]);
      if (!match[2] && request.method === "PATCH") { const companion=await configureCompanion(ownerId,id,await request.json()); return companion ? json({companion}) : json({error:"Companion not found."},404); }
      if (!match[2] && request.method === "GET") { const result = await detail(ownerId, id); return result ? json({...result,files:await filesForThread(ownerId,id)}) : json({ error: "Companion not found." }, 404); }
      if (match[2] === "messages" && request.method === "POST") {
        const body = z.object({ clientMessageId: idSchema, content: z.string().trim().min(1).max(50_000), attachmentCount: z.number().int().min(0).max(5).default(0) }).parse(await request.json());
        const runId = await acceptMessage(ownerId, id, body.clientMessageId, body.content, body.attachmentCount);
        return runId ? json({ runId }, 202) : json({ error: "Companion not found." }, 404);
      }
      if (match[2] === "cancel" && request.method === "POST") return await cancel(ownerId, id) ? json({ ok: true }) : json({ error: "Companion not found." }, 404);
      if (match[2] === "desktop" && request.method === "POST") {
        const [row] = await db`SELECT box_id,status FROM companions WHERE id=${id} AND owner_id=${ownerId} AND provider='box'`;
        if (!row || row.status !== "ready" || !config.boxKey) return json({ error: "Send a message first to prepare this Box." }, 409);
        // V0 desktop viewing only; explicit GUI takeover is a later ticket.
        return json({ url: await new BoxClient(config.boxKey).desktop(row.box_id) });
      }
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof AuthenticationRequired) return json({ error: "Authentication required." }, 401);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid request." }, 400);
    if (error instanceof PluginError) return json({error:error.message},400);
    if (error instanceof Conflict) return json({ error: error.message }, 409);
    console.error(error instanceof BoxError ? `api_request_failed:${error.code}:${error.status}` : "api_request_failed");
    return json({ error: "The request could not be completed. Please try again." }, 500);
  }
}
if (import.meta.main) {
  await migrate();
  Bun.serve({ hostname: "127.0.0.1", port: config.port, maxRequestBodySize: FILE_REQUEST_MAX_BYTES, fetch: handler });
  console.log(`API ready at http://127.0.0.1:${config.port}`);
}
