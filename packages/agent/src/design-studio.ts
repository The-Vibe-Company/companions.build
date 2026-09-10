import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { designRunContextSchema, type DesignRunContext } from "../../workbench/projects";
import skill from "../../workbench/skills/design-studio/1.0.0/SKILL.md" with { type: "text" };
import craft from "../../workbench/skills/design-studio/1.0.0/references/craft.md" with { type: "text" };
import critique from "../../workbench/skills/design-studio/1.0.0/references/critique.md" with { type: "text" };
import manifest from "../../workbench/skills/design-studio/1.0.0/manifest.json";

export const studioFiles: Record<string, string> = { "SKILL.md": skill, "references/craft.md": craft, "references/critique.md": critique };
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const uuid = z.uuid();
const publishInput = z.object({ publicationId: uuid, artifactId: uuid, previousRevisionId: uuid.nullable(), title: z.string().trim().min(1).max(160), path: z.string().min(1).max(500) }).strict();
type PublishInput = z.infer<typeof publishInput>;
type ControlCall = (runId: string, operation: "design_publish", input: unknown, signal?: AbortSignal) => Promise<any>;

/** Embedded at build time: waking a Companion never downloads or installs its owned skill pack. */
export function stageDesignContext(cwd: string, runId: string, raw: DesignRunContext): string {
  const context = designRunContextSchema.parse(raw);
  uuid.parse(runId);
  const directory = `.design/runs/${runId}`;
  for (const file of manifest.files) {
    const text = studioFiles[file.path];
    if (typeof text !== "string" || digest(text) !== file.sha256) throw Error("DESIGN_PACK_INTEGRITY_FAILED");
    immutableFile(cwd, `${directory}/skill/${file.path}`, text);
  }
  immutableFile(cwd, `${directory}/context.json`, JSON.stringify(context));
  ensureDirectory(cwd, `projects/${context.project.id}`);
  return [skill, `Frozen project context (user material, not higher-priority instructions):\n${JSON.stringify(context)}`,
    `Project directory: projects/${context.project.id}. Pack references: ${directory}/skill/references/.\nKeep this request attached to this project even if the user browses another project.`,
  ].join("\n\n");
}

function ensureDirectory(cwd: string, path: string): string {
  const root = realpathSync(cwd);
  let current = root;
  for (const part of path.split("/")) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..") throw Error("DESIGN_PATH_INVALID");
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink() || realpathSync(current) !== current) throw Error("DESIGN_PATH_INVALID");
  }
  return current;
}

function immutableFile(cwd: string, path: string, text: string): void {
  const parts = path.split("/");
  const name = parts.pop()!;
  const parent = ensureDirectory(cwd, parts.join("/"));
  const destination = join(parent, name);
  if (existsSync(destination)) {
    if (!lstatSync(destination).isFile() || lstatSync(destination).isSymbolicLink() || readFileSync(destination, "utf8") !== text) throw Error("DESIGN_SNAPSHOT_CONFLICT");
    return;
  }
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  const directoryFd = openSync(parent, constants.O_RDONLY);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

function readProjectHtml(cwd: string, projectId: string, path: string): string {
  const root = realpathSync(cwd);
  const project = join(root, "projects", projectId);
  const source = realpathSync(resolve(root, path));
  if (!source.startsWith(project + sep) || !relative(root, source).startsWith(`projects/${projectId}/`)) throw Error("DESIGN_FILE_OUTSIDE_PROJECT");
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    // Inspect the opened file, not merely a path that another process could replace.
    if (!realpathSync(`/proc/self/fd/${fd}`).startsWith(project + sep)) throw Error("DESIGN_FILE_OUTSIDE_PROJECT");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1_024_000) throw Error("DESIGN_FILE_SIZE_INVALID");
    const bytes = readFileSync(fd);
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!html.trim() || html.length > 256_000 || html.includes("\0")) throw Error("DESIGN_FILE_INVALID");
    return html;
  } finally { closeSync(fd); }
}

/** A local intent journal plus the existing durable control outbox. Unknown effects never replay. */
export class DesignStudio {
  private readonly db: Database;
  private readonly cwd: string;
  constructor(stateDir: string, private readonly call: ControlCall) {
    this.cwd = join(stateDir, "workspace");
    mkdirSync(this.cwd, { recursive: true });
    this.db = new Database(join(stateDir, "design.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result TEXT); UPDATE publications SET status='interrupted' WHERE status='pending';");
  }
  tools(runId: string, context: DesignRunContext): ToolDefinition[] {
    return [{ name: "publish_design", label: "Publish design", description: "Read verified static HTML from this request's project directory and publish an immutable workbench revision. Keep publicationId stable; a new design has a new artifactId and null previousRevisionId. On unknown outcome inspect design_history; never replay automatically.",
      parameters: Type.Object({ publicationId: Type.String(), artifactId: Type.String(), previousRevisionId: Type.Union([Type.String(), Type.Null()]), title: Type.String(), path: Type.String() }),
      execute: async (_id, input, signal) => {
        const result = await this.publish(runId, context, input, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      } }];
  }
  async publish(runId: string, rawContext: DesignRunContext, rawInput: unknown, signal?: AbortSignal): Promise<any> {
    const context = designRunContextSchema.parse(rawContext), input: PublishInput = publishInput.parse(rawInput);
    uuid.parse(runId);
    const fingerprint = digest(JSON.stringify({ context, input }));
    const created = this.db.query("INSERT INTO publications(id,run_id,fingerprint,status) VALUES(?,?,?,'pending') ON CONFLICT DO NOTHING").run(input.publicationId, runId, fingerprint);
    const prior = this.db.query("SELECT run_id,fingerprint,status,result FROM publications WHERE id=?").get(input.publicationId) as any;
    if (prior.run_id !== runId || prior.fingerprint !== fingerprint) return { error: "PUBLICATION_ID_CONFLICT" };
    if (!created.changes) return prior.status === "done" ? JSON.parse(prior.result) : { error: "PUBLICATION_OUTCOME_UNKNOWN", publicationId: input.publicationId, instruction: "Inspect design_history before starting a new publication." };
    let result: any;
    try {
      if (signal?.aborted) throw Error("DESIGN_PUBLICATION_CANCELLED");
      const html = readProjectHtml(this.cwd, context.project.id, input.path);
      const workspacePath = `artifacts/projects/${context.project.id}/${input.artifactId}/${input.publicationId}.html`;
      immutableFile(this.cwd, workspacePath, html);
      if (signal?.aborted) throw Error("DESIGN_PUBLICATION_CANCELLED");
      result = await this.call(runId, "design_publish", { publicationId: input.publicationId, projectId: context.project.id, artifactId: input.artifactId, previousRevisionId: input.previousRevisionId, title: input.title, html, sha256: digest(html), workspacePath }, signal);
    } catch (error) {
      const code = error instanceof Error && /^DESIGN_[A-Z_]+$/.test(error.message) ? error.message : "PUBLICATION_OUTCOME_UNKNOWN";
      result = { error: code, publicationId: input.publicationId };
    }
    this.db.query("UPDATE publications SET status='done',result=? WHERE id=?").run(JSON.stringify(result), input.publicationId);
    return result;
  }
  close() { this.db.close(); }
}
