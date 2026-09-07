import {requireHostedActivation,mutationStartsWork} from "./activation";
import {handleMaintenance} from "./maintenance";
import {availableModels} from "./models";
import { handleBilling, handleStripeWebhook, requireProductActivation, billingConfiguration, ProductActivationRequired } from "./billing";
import { handleDelivery } from "./delivery";
import { handleLifecycle } from "./lifecycle";
import {listTemplateRevisions,rollbackTemplate} from "./templates";
import { LifecycleConflict } from "./templates";
import { z } from "zod";
import { config } from "./config";
import { db, migrateForService, listCompanions, createCompanion, detail, acceptMessage, cancel, Conflict } from "./store";
import { BoxClient, BoxError } from "../../../packages/box/client";
import { auth, AuthenticationRequired, requireUser, sessionUser } from "./auth";

import { handleWebhook, handleTriggers } from "./triggers";
import { handlePlugins, PluginError } from "./plugins";
import { handleFiles, filesForThread, FILE_REQUEST_MAX_BYTES } from "./files";
import { handleAutomations } from "./automation-routes";
import { avatarSchema, configureCompanion } from "./control";
import { handleCompanionEvents } from "./events";
import { serveStaticWeb } from "./static-web";
import { prepareTemplateSoftware, softwareRootsSchema, SoftwareConflict, SoftwareUnavailable, templateSoftwareStatus } from "./software";

const idSchema = z.string().uuid();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
async function lifecycleRoute(request:Request,ownerId:string):Promise<Response|null> {
 const path=new URL(request.url).pathname;
 if(path==='/api/templates') {
  if(request.method==='GET')return json({templates:await handleLifecycle({operation:'templates'},ownerId)});
  if(request.method==='POST')return json(await handleLifecycle({operation:'template_save',input:await request.json()},ownerId),201);
 }
 const revisions=path.match(/^\/api\/templates\/([^/]+)\/(revisions|rollback)$/);
 if(revisions){const id=idSchema.parse(revisions[1]);
  if(revisions[2]==='revisions'&&request.method==='GET')return json({revisions:await listTemplateRevisions(ownerId,id)});
  if(revisions[2]==='rollback'&&request.method==='POST')return json(await rollbackTemplate(ownerId,id,await request.json()));
 }
 const software=path.match(/^\/api\/templates\/([^/]+)\/software\/(prepare|status)$/);
 if(software){
  const templateId=idSchema.parse(software[1]);
  if(software[2]==='status'&&request.method==='GET'){
   const buildId=new URL(request.url).searchParams.get('buildId')??undefined;
   return json(await templateSoftwareStatus(ownerId,templateId,buildId));
  }
  if(software[2]==='prepare'&&request.method==='POST'){
   const body=z.object({clientCommandId:idSchema,expectedRevision:z.number().int().positive()}).extend(softwareRootsSchema.shape).strict().parse(await request.json());
   const {clientCommandId,...input}=body;
   return json(await prepareTemplateSoftware(ownerId,clientCommandId,{templateId,...input}),202);
  }
 }
 const template=path.match(/^\/api\/templates\/([^/]+)$/);
 if(template&&request.method==='PATCH')return json(await handleLifecycle({operation:'template_save',input:{...await request.json() as object,id:idSchema.parse(template[1])}},ownerId));
 const permission=path.match(/^\/api\/companions\/([^/]+)\/templates(?:\/([^/]+))?$/);
 if(permission){
  const id=idSchema.parse(permission[1]);
  const [owned]=await db`SELECT id FROM companions WHERE id=${id} AND owner_id=${ownerId} AND retired_at IS NULL`;
  if(!owned)return json({error:'Companion not found.'},404);
  if(request.method==='GET'&&!permission[2])return json({templates:await db`SELECT p.template_id AS "templateId",p.max_children AS "maxChildren",t.name,t.revision FROM template_permissions p JOIN agent_templates t ON t.id=p.template_id WHERE p.parent_id=${id} AND t.owner_id=${ownerId}`});
  if(request.method==='PUT'&&permission[2])return json(await handleLifecycle({operation:'template_permission',companionId:id,input:{...await request.json() as object,templateId:idSchema.parse(permission[2])}},ownerId));
 }
 const replicas=path.match(/^\/api\/companions\/([^/]+)\/replicas$/);
 if(replicas){
  const id=idSchema.parse(replicas[1]);
  const [owned]=await db`SELECT id FROM companions WHERE id=${id} AND owner_id=${ownerId} AND retired_at IS NULL`;
  if(!owned)return json({error:'Companion not found.'},404);
  if(request.method==='GET')return json({replicas:await db`SELECT id,name,avatar,status,error,template_id AS "templateId",template_revision AS "templateRevision",retired_at AS "retiredAt" FROM companions WHERE parent_id=${id} AND owner_id=${ownerId} AND retired_at IS NULL ORDER BY created_at`});
  if(request.method==='POST'){const {clientCommandId,...input}=await request.json() as any;return json(await handleLifecycle({operation:'spawn',companionId:id,commandId:clientCommandId,input},ownerId),202);}
 }
 const desktop=path.match(/^\/api\/companions\/([^/]+)\/desktop\/(takeover|release)$/);
 if(desktop&&request.method==='POST')return json(await handleLifecycle({operation:'desktop_'+desktop[2],companionId:idSchema.parse(desktop[1]),source:'human'},ownerId),202);
 const match=path.match(/^\/api\/companions\/([^/]+)\/(prepare|desktop-takeover|desktop-release|template-permission|spawn|adopt-template)$/);
 if(!match||request.method!=='POST')return null;
 const companionId=idSchema.parse(match[1]);
 const body=await request.text();const input=body?JSON.parse(body):{};
 const {commandId,runId,...value}=input;
 return json(await handleLifecycle({operation:match[2].replaceAll('-','_'),companionId,commandId,runId,input:value,source:'human'},ownerId),202);
}
export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if(url.pathname === "/api/stripe/webhook") return handleStripeWebhook(request);
  const webhookResponse = await handleWebhook(request);
  if(webhookResponse) return webhookResponse;
  if (url.pathname === "/health") return json({ ok: true });
  // Reject cross-origin browser writes, including login. Vite forwards same origin.
  const origin = request.headers.get("origin");
  if (origin && ![url.origin, process.env.APP_URL ?? "http://127.0.0.1:4310", `http://localhost:${process.env.WEB_PORT ?? 4310}`].includes(origin)) return json({ error: "Origin not allowed." }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > (url.pathname.endsWith("/files") ? FILE_REQUEST_MAX_BYTES : 100_000)) return json({ error: "Request too large." }, 413);
  const apiPath = url.pathname === "/api" || url.pathname.startsWith("/api/");
  if (!apiPath) return await serveStaticWeb(request, config.webDist) ?? json({ error: "Not found." }, 404);
  try {
    if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
    if (request.method === "GET" && url.pathname === "/api/me") {
      const user = await sessionUser(request);
      return user ? json({ user: { id: user.id, email: user.email, name: user.name } }) : json({ error: "Authentication required." }, 401);
    }
    const ownerId = await requireUser(request);
    if(mutationStartsWork(url.pathname,request.method))await requireHostedActivation(ownerId);
    const maintenanceResponse=await handleMaintenance(request,ownerId);
    if(maintenanceResponse)return maintenanceResponse;
    const billingResponse = await handleBilling(request,ownerId);
    if(billingResponse) return billingResponse;
    const deliveryResponse = await handleDelivery(request,ownerId);
    if(deliveryResponse) return deliveryResponse;
    const lifecycleResponse = await lifecycleRoute(request,ownerId);
    if(lifecycleResponse) return lifecycleResponse;
    const triggerResponse = await handleTriggers(request,ownerId);
    if(triggerResponse) return triggerResponse;
    const fileResponse = await handleFiles(request,ownerId);
    if(fileResponse) return fileResponse;
    const automationResponse = await handleAutomations(request,ownerId);
    if(automationResponse) return automationResponse;
    const pluginResponse = await handlePlugins(request,ownerId);
    if(pluginResponse) return pluginResponse;
    if (request.method === "GET" && url.pathname === "/api/config") return json({ models:await availableModels(),localAvailable: config.localAvailable, boxAvailable: !!(config.boxKey && config.boxTemplate), model: config.testMode ? "Local test model" : `${config.modelProvider}/${config.modelId}` });
    if (url.pathname === "/api/companions") {
      if (request.method === "GET") return json({ companions: await listCompanions(ownerId) });
      if (request.method === "POST") {
        if(billingConfiguration().mode === "stripe" || process.env.NODE_ENV === "production") await requireProductActivation(ownerId);
        const input = z.object({ clientCreationId:idSchema.optional(),name: z.string().trim().min(1).max(80), instructions: z.string().max(20_000).optional(), provider: z.enum(["local", "box"]), avatar: avatarSchema.optional(), templateId:idSchema.optional(), templateRevision:z.number().int().positive().optional() }).parse(await request.json());
        if (input.provider === "box" && (!config.boxKey || !config.boxTemplate)) return json({ error: "Box needs an API key and a prepared template." }, 409);
        if (input.provider === "local" && !config.localAvailable) return json({ error: "Local runtime is disabled." }, 409);
        return json({ companion: await createCompanion(ownerId, {...input,prepare:true}) }, 201);
      }
    }
    const match = url.pathname.match(/^\/api\/companions\/([^/]+)(?:\/(messages|cancel|desktop|events))?$/);
    if (match) {
      const id = idSchema.parse(match[1]);
      if (!match[2] && request.method === "PATCH") { const companion=await configureCompanion(ownerId,id,await request.json()); return companion ? json({companion}) : json({error:"Companion not found."},404); }
      if (!match[2] && request.method === "GET") { const result = await detail(ownerId, id);
        if(!result)return json({error:"Companion not found."},404);
        const files=await filesForThread(ownerId,id);
        const questions=await db`SELECT q.id,q.run_id AS "runId",q.question,q.options,q.answer FROM task_questions q JOIN runs r ON r.id=q.run_id WHERE q.companion_id=${id} AND r.status IN ('running','needs_input','preparing') AND q.answer IS NULL ORDER BY q.created_at`;
        return json({...result,questions,files,messages:result.messages.map((m:any)=>({...m,files:files.filter(f=>f.runId===m.runId&&f.kind===(m.role==='user'?'user_upload':'agent_output'))}))}); }
      if (match[2] === "events" && request.method === "GET") return handleCompanionEvents(request, ownerId, id);
      if (match[2] === "messages" && request.method === "POST") {
        const body = z.object({ clientMessageId: idSchema, content: z.string().trim().min(1).max(50_000), attachmentCount: z.number().int().min(0).max(5).default(0) }).parse(await request.json());
        const runId = await acceptMessage(ownerId, id, body.clientMessageId, body.content, body.attachmentCount);
        return runId ? json({ runId }, 202) : json({ error: "Companion not found." }, 404);
      }
      if (match[2] === "cancel" && request.method === "POST") return await cancel(ownerId, id) ? json({ ok: true }) : json({ error: "Companion not found." }, 404);
      if (match[2] === "desktop" && request.method === "POST") {
        const [row] = await db`SELECT box_id,status FROM companions WHERE id=${id} AND owner_id=${ownerId} AND provider='box'`;
        if (!row) return json({error:"Companion not found."},404);
        if(row.status !== "ready" || !config.boxKey) {await handleLifecycle({operation:"open_desktop",companionId:id},ownerId);return json({preparing:true},202);}
        return json({ url: await new BoxClient(config.boxKey).desktop(row.box_id) });
      }
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof BoxError && error.code === "desktop_preparing") return json({preparing:true},202);
    if (error instanceof AuthenticationRequired) return json({ error: "Authentication required." }, 401);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid request." }, 400);
    if (error instanceof PluginError) return json({error:error.message},400);
    if (error instanceof SoftwareConflict || error instanceof SoftwareUnavailable) return json({error:error.message},409);
    if (error instanceof ProductActivationRequired) return json({error:error.message},402);
    if (error instanceof LifecycleConflict) return json({error:error.message},409);
    if (error instanceof Conflict) return json({ error: error.message }, 409);
    console.error(error instanceof BoxError ? `api_request_failed:${error.code}:${error.status}` : "api_request_failed");
    return json({ error: "The request could not be completed. Please try again." }, 500);
  }
}
if (import.meta.main) {
  await migrateForService();
  Bun.serve({ hostname: config.host, port: config.port, maxRequestBodySize: FILE_REQUEST_MAX_BYTES, fetch: handler });
  console.log(`API ready at http://${config.host}:${config.port}`);
}
