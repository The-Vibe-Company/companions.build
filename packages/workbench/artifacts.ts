import { z } from "zod";
import { activeDesignSkill, designSkill, resolveProfile } from "./profiles";

export const profileIdSchema = z.enum(["default-v1", "design-v1", "design-v2"]);
export const conversationSchema = z.object({
  // Main conversation ID is the Companion ID; background ID is the response-root run ID.
  kind: z.enum(["main", "background"]), id: z.uuid(),
}).strict();
export const skillReferenceSchema = z.object({ id: z.literal(designSkill.id), version: z.literal(designSkill.version) }).strict();
export const workspacePathSchema = z.string().min(1).max(500).refine(value =>
  value.startsWith("artifacts/") && value.split("/").every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== ".."),
  "Expected a relative artifact workspace path",
);
export const provenanceSchema = z.object({
  companionId: z.uuid(), runId: z.uuid(), conversation: conversationSchema,
  profileId: z.literal("design-v1"), skill: skillReferenceSchema,
}).strict();
export const artifactRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: z.uuid(), revisionId: z.uuid(), revision: z.number().int().min(1).max(1_000_000),
  previousRevisionId: z.uuid().nullable(), title: z.string().trim().min(1).max(160),
  kind: z.literal("static-html"), renderer: z.literal("sandboxed-html-v1"),
  status: z.enum(["ready", "failed"]), failureCode: z.enum(["generation_failed", "validation_failed", "render_failed"]).nullable(),
  source: z.object({ workspacePath: workspacePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  provenance: provenanceSchema, createdAt: z.iso.datetime(),
}).strict().refine(value => (value.status === "failed") === (value.failureCode !== null), "Failure status and code must agree")
  .refine(value => (value.revision === 1) === (value.previousRevisionId === null), "Revisions must link to their predecessor");
export type ArtifactRevision = z.infer<typeof artifactRevisionSchema>;

export const activeSkillReferenceSchema=z.object({id:z.literal(activeDesignSkill.id),version:z.literal(activeDesignSkill.version)}).strict();
export const designProvenanceSchema=z.object({
 companionId:z.uuid(),runId:z.uuid(),conversation:conversationSchema,profileId:z.literal("design-v2"),
 skill:activeSkillReferenceSchema,projectId:z.uuid(),projectRevision:z.number().int().positive(),
}).strict();
export const designArtifactRevisionSchema=z.object({
 schemaVersion:z.literal(2),artifactId:z.uuid(),revisionId:z.uuid(),revision:z.number().int().min(1).max(1_000_000),
 previousRevisionId:z.uuid().nullable(),title:z.string().trim().min(1).max(160),kind:z.literal("static-html"),
 renderer:z.literal("sandboxed-html-v1"),status:z.enum(["ready","failed"]),
 failureCode:z.enum(["generation_failed","validation_failed","render_failed"]).nullable(),
 source:z.object({workspacePath:workspacePathSchema,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 provenance:designProvenanceSchema,createdAt:z.iso.datetime(),
}).strict().refine(value=>(value.status==="failed")===(value.failureCode!==null),"Failure status and code must agree")
 .refine(value=>(value.revision===1)===(value.previousRevisionId===null),"Revisions must link to their predecessor");
export type DesignArtifactRevision=z.infer<typeof designArtifactRevisionSchema>;
export const anyArtifactRevisionSchema=z.discriminatedUnion("schemaVersion",[artifactRevisionSchema,designArtifactRevisionSchema]);
export type AnyArtifactRevision=z.infer<typeof anyArtifactRevisionSchema>;

/** Publication is an internal persistence seam; no public or agent publisher ships in v1. */
export const artifactPublicationSchema = z.object({
  manifest: artifactRevisionSchema,
  html: z.string().min(1).max(256_000).nullable(),
}).strict().refine(value => (value.manifest.status === "ready") === (value.html !== null), "Only ready revisions contain a preview");
export type ArtifactPublication = z.infer<typeof artifactPublicationSchema>;
export const designArtifactPublicationSchema=z.object({manifest:designArtifactRevisionSchema,html:z.string().min(1).max(256_000).nullable()}).strict()
 .refine(value=>(value.manifest.status==="ready")===(value.html!==null),"Only ready revisions contain a preview");
export type DesignArtifactPublication=z.infer<typeof designArtifactPublicationSchema>;
export const anyArtifactPublicationSchema=z.union([artifactPublicationSchema,designArtifactPublicationSchema]);

const eventBase = { id: z.uuid(), provenance: provenanceSchema, createdAt: z.iso.datetime() };
export const workbenchEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("artifact.revision"), artifactId: z.uuid(), revisionId: z.uuid() }).strict(),
  z.object({ ...eventBase, type: z.literal("workbench.open"), moduleId: z.enum(["artifact-preview", "artifact-history", "assets", "design-brief"]), artifactId: z.uuid().optional() }).strict(),
]);
export type LegacyWorkbenchEvent = z.infer<typeof workbenchEventSchema>;
const designEventBase={id:z.uuid(),provenance:designProvenanceSchema,createdAt:z.iso.datetime()};
export const designWorkbenchEventSchema=z.discriminatedUnion("type",[
 z.object({...designEventBase,type:z.literal("artifact.revision"),artifactId:z.uuid(),revisionId:z.uuid()}).strict(),
 z.object({...designEventBase,type:z.literal("workbench.open"),moduleId:z.enum(["artifact-preview","artifact-history","assets","design-brief"]),artifactId:z.uuid().optional()}).strict(),
]);
export const anyWorkbenchEventSchema=z.union([workbenchEventSchema,designWorkbenchEventSchema]);
export type AnyWorkbenchEvent=z.infer<typeof anyWorkbenchEventSchema>;
export type WorkbenchEvent=AnyWorkbenchEvent;
export function parseWorkbenchEvent(value: unknown): WorkbenchEvent | null {
  const result = anyWorkbenchEventSchema.safeParse(value);
  if (!result.success) return null;
  const event = result.data;
  if (event.type === "workbench.open" && !resolveProfile(event.provenance.profileId).modules.includes(event.moduleId)) return null;
  return event;
}
export interface WorkbenchSnapshot { revisions: AnyArtifactRevision[]; events: AnyWorkbenchEvent[]; hasMore: boolean; nextCursor?:string|null }
export interface ArtifactPreview { revisionId: string; html: string }

export const designPublicationInputSchema=z.object({
 publicationId:z.uuid(),projectId:z.uuid(),artifactId:z.uuid(),previousRevisionId:z.uuid().nullable(),
 title:z.string().trim().min(1).max(160),html:z.string().min(1).max(256_000),sha256:z.string().regex(/^[a-f0-9]{64}$/),
 workspacePath:workspacePathSchema,
}).strict();
export type DesignPublicationInput=z.infer<typeof designPublicationInputSchema>;

// Static snapshots are inert documents. Live URLs, scripts and refresh permissions require a separate contract.
export const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function previewDocument(html: string): string {
  if (!html.trim() || html.length > 256_000 || /\u0000/.test(html)) throw new Error("Invalid preview document");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}
