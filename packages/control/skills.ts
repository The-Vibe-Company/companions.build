import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, posix, sep } from "node:path";
import { z } from "zod";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 500;
const MARKER = ".companions-skill-import.json";
const REMOVALS = ".companions-skill-removals.json";
const nameSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
const fileSchema = z.object({
  path: z.string().min(1).max(500),
  data: z.string().max(Math.ceil(MAX_BYTES*4/3)+4),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifestSchema = z.object({
  version: z.literal(1),
  skills: z.array(z.object({ name: nameSchema, files: z.array(fileSchema).min(1) })),
});
const operationIdSchema=z.string().uuid();
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const controlSkillSchema=z.object({name:nameSchema,files:z.array(fileSchema).min(1)}).strict();
const removalSchema=z.object({version:z.literal(1),entries:z.array(z.object({id:operationIdSchema,name:nameSchema,expectedHash:hashSchema,identity:z.string(),removed:z.boolean(),complete:z.boolean()})).max(500)}).strict();

export type SkillManifest = z.infer<typeof manifestSchema>;
type ValidatedSkill = { name: string; files: Array<{ path: string; bytes: Buffer; sha256: string }>; hash: string };
export type SkillMutationCheckpoint = { name: string; currentHash: string | null; targetHash: string; bundleHash: string };

class SkillTransferError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

export class AgentSkills {
  private readonly importRoot: string;
  private readonly roots: string[];
  private readonly stateRoot: string;
  private readonly removalsPath:string;

  constructor(stateDir: string) {
    this.importRoot = join(stateDir, "pi", "skills");
    this.roots = [this.importRoot, join(stateDir, "workspace", ".pi", "skills")];
    mkdirSync(this.importRoot, { recursive: true, mode: 0o700 });
    this.stateRoot = realpathSync(stateDir);
    this.removalsPath=join(this.importRoot,REMOVALS);
  }

  control(operation:"skills"|"skill_install"|"skill_update"|"skill_remove",raw:unknown){
    try{
      if(operation==="skills"){
        z.object({}).strict().parse(raw);
        return {skills:this.discover().map(skill=>({name:skill.name,description:description(skill.files),hash:skill.hash,editable:this.packageInRoot(this.importRoot,skill.name)!==null}))};
      }
      if(operation==="skill_remove"){
        const value=z.object({clientOperationId:operationIdSchema,name:nameSchema,expectedHash:hashSchema}).strict().parse(raw);
        return this.remove(value.clientOperationId,value.name,value.expectedHash);
      }
      const value=z.object({clientOperationId:operationIdSchema,expectedHash:hashSchema.optional(),skill:controlSkillSchema}).strict().parse(raw);
      const skills=validateManifest({version:1,skills:[value.skill]});
      if(operation==="skill_install"&&value.expectedHash!==undefined)throw new SkillTransferError("INVALID_SKILL_OPERATION");
      if(operation==="skill_update"&&value.expectedHash===undefined)throw new SkillTransferError("INVALID_SKILL_OPERATION");
      return this.import(skills,operation==="skill_install"?{mode:"install"}:{mode:"update",expectedHash:value.expectedHash});
    }catch(error){
      if(error instanceof SkillTransferError)return {error:error.code};
      if(error instanceof z.ZodError||error instanceof SyntaxError)return {error:"INVALID_SKILL_OPERATION"};
      return {error:"SKILL_OPERATION_FAILED"};
    }
  }

  /** Captures enough pre-mutation state to reconcile a crash between the filesystem rename and
   * the local idempotency journal commit. Invalid/conflicting requests remain safe to replay. */
  mutationCheckpoint(raw:unknown):SkillMutationCheckpoint|null{
    try{
      const value=z.object({clientOperationId:operationIdSchema,expectedHash:hashSchema.optional(),skill:controlSkillSchema}).strict().parse(raw);
      const [skill]=validateManifest({version:1,skills:[value.skill]});
      if(this.packageInRoot(this.roots[1],skill.name))return null;
      return {name:skill.name,currentHash:this.packageInRoot(this.importRoot,skill.name)?.hash??null,targetHash:skill.hash,bundleHash:bundleHash([skill])};
    }catch{return null;}
  }

  reconcileMutation(operation:"skill_install"|"skill_update",raw:unknown,before:SkillMutationCheckpoint){
    const current=this.mutationCheckpoint(raw);
    if(!current||current.name!==before.name||current.targetHash!==before.targetHash||current.bundleHash!==before.bundleHash)return {error:"SKILL_OPERATION_CONFLICT"};
    if(current.currentHash===before.currentHash)return this.control(operation,raw);
    if(current.currentHash!==before.targetHash)return {error:"SKILL_NAME_CONFLICT"};
    const changed=before.currentHash!==before.targetHash;
    return {bundleHash:before.bundleHash,imported:changed?[before.name]:[],unchanged:changed?[]:[before.name]};
  }

  async handleRequest(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/skills" && request.method === "GET") {
        return Response.json({ skills: this.discover().map(skill => ({ name: skill.name, description: description(skill.files) })) });
      }
      if (url.pathname === "/skills/export" && request.method === "GET") {
        const requested = [...url.searchParams.getAll("name"), ...(url.searchParams.get("names")?.split(",") ?? [])].filter(Boolean);
        const names = requested.length ? new Set(requested.map(value => nameSchema.parse(value))) : null;
        const discovered = this.discover(names);
        const selected = names ? discovered.filter(skill => names.has(skill.name)) : discovered;
        if (names && selected.length !== names.size) throw new SkillTransferError("SKILL_NOT_FOUND", 404);
        if (selected.reduce((count, skill) => count + skill.files.length, 0) > MAX_FILES || selected.reduce((size, skill) => size + skill.files.reduce((sum, file) => sum + file.bytes.length, 0), 0) > MAX_BYTES) {
          throw new SkillTransferError("SKILL_BUNDLE_TOO_LARGE", 413);
        }
        const manifest: SkillManifest = { version: 1, skills: selected.map(skill => ({ name: skill.name, files: skill.files.map(file => ({ path: file.path, data: file.bytes.toString("base64"), sha256: file.sha256 })) })) };
        return Response.json(manifest);
      }
      if (url.pathname === "/skills/import" && request.method === "PUT") {
        const skills = validateManifest(await request.json());
        return Response.json(this.import(skills));
      }
      return null;
    } catch (error) {
      if (error instanceof SkillTransferError) return Response.json({ error: error.code }, { status: error.status });
      if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "INVALID_SKILL_BUNDLE" }, { status: 400 });
      return Response.json({ error: "SKILL_TRANSFER_FAILED" }, { status: 400 });
    }
  }

  private discover(only: Set<string> | null = null): ValidatedSkill[] {
    const found = new Map<string, ValidatedSkill>();
    for (const root of this.roots) {
      if (!this.safeRoot(root)) continue;
      let entries;
      try { entries = readdirSync(root, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (!nameSchema.safeParse(entry.name).success) continue;
        if (only && !only.has(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new SkillTransferError("UNSAFE_SKILL_PACKAGE");
        if (!entry.isDirectory()) continue;
        const directory = join(root, entry.name);
        let skillFile;
        try { skillFile = lstatSync(join(directory, "SKILL.md")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (!skillFile.isFile()) throw new SkillTransferError("UNSAFE_SKILL_PACKAGE");
        if (found.has(entry.name)) throw new SkillTransferError("DUPLICATE_SKILL_NAME", 409);
        found.set(entry.name, readPackage(directory, entry.name));
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private import(skills: ValidatedSkill[],control?:{mode:"install"|"update";expectedHash?:string}) {
    if (!this.safeRoot(this.importRoot)) throw new SkillTransferError("UNSAFE_SKILL_PACKAGE");
    const names = new Set<string>();
    const actions: Array<{ skill: ValidatedSkill; target: string; replace: boolean }> = [];
    const unchanged: string[] = [];
    for (const skill of skills) {
      if (names.has(skill.name)) throw new SkillTransferError("DUPLICATE_SKILL_NAME");
      names.add(skill.name);
      if(this.packageInRoot(this.roots[1],skill.name))throw new SkillTransferError("SKILL_NAME_CONFLICT",409);
      const target = join(this.importRoot, skill.name);
      let info;
      try { info = lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!info) {
        if(control?.mode==="update")throw new SkillTransferError("SKILL_NOT_FOUND",404);
        actions.push({ skill, target, replace: false }); continue;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new SkillTransferError("SKILL_NAME_CONFLICT", 409);
      let existing: ValidatedSkill;
      try { existing = readPackage(target, skill.name); } catch { throw new SkillTransferError("SKILL_NAME_CONFLICT", 409); }
      if(control?.mode==="update"&&control.expectedHash!==existing.hash)throw new SkillTransferError("SKILL_NAME_CONFLICT",409);
      if (existing.hash === skill.hash) { unchanged.push(skill.name); continue; }
      if(control?.mode==="install")throw new SkillTransferError("SKILL_NAME_CONFLICT",409);
      if(!control&&readMarker(target)!==existing.hash)throw new SkillTransferError("SKILL_NAME_CONFLICT",409);
      actions.push({ skill, target, replace: true });
    }

    const staged: Array<{ action: typeof actions[number]; directory: string }> = [];
    try {
      for (const action of actions) {
        const directory = join(this.importRoot, `.import-${crypto.randomUUID()}`);
        mkdirSync(directory, { mode: 0o700 });
        staged.push({ action, directory });
        for (const file of action.skill.files) {
          const target = join(directory, ...file.path.split("/"));
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, file.bytes, { flag: "wx", mode: 0o600 });
        }
        writeFileSync(join(directory, MARKER), JSON.stringify({ version: 1, hash: action.skill.hash }), { flag: "wx", mode: 0o600 });
      }
    } catch (error) {
      for (const item of staged) rmSync(item.directory, { recursive: true, force: true });
      throw error;
    }

    for (const item of staged) {
      const backup = `${item.action.target}.previous-${crypto.randomUUID()}`;
      if (item.action.replace) renameSync(item.action.target, backup);
      try { renameSync(item.directory, item.action.target); }
      catch (error) {
        if (item.action.replace) renameSync(backup, item.action.target);
        throw error;
      }
      if (item.action.replace) rmSync(backup, { recursive: true, force: true });
    }
    return { bundleHash: bundleHash(skills), imported: actions.map(item => item.skill.name), unchanged };
  }

  private packageInRoot(root:string,name:string):ValidatedSkill|null{
    if(!this.safeRoot(root))return null;const target=join(root,name);let info;
    try{info=lstatSync(target);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
    if(!info.isDirectory()||info.isSymbolicLink())throw new SkillTransferError("SKILL_NAME_CONFLICT",409);
    return readPackage(target,name);
  }

  private removalJournal():z.infer<typeof removalSchema>{
    try{const info=lstatSync(this.removalsPath);if(!info.isFile()||info.isSymbolicLink())throw new SkillTransferError("SKILL_OPERATION_JOURNAL_INVALID");return removalSchema.parse(JSON.parse(readFileSync(this.removalsPath,"utf8")));}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {version:1,entries:[]};throw new SkillTransferError("SKILL_OPERATION_JOURNAL_INVALID");}
  }
  private saveRemovalJournal(journal:z.infer<typeof removalSchema>){
    const temporary=join(this.importRoot,`.removals-${crypto.randomUUID()}`);writeFileSync(temporary,JSON.stringify(journal),{flag:"wx",mode:0o600});renameSync(temporary,this.removalsPath);
  }
  private remove(id:string,name:string,expectedHash:string){
    if(!this.safeRoot(this.importRoot))throw new SkillTransferError("UNSAFE_SKILL_PACKAGE");
    const journal=this.removalJournal();let entry=journal.entries.find(item=>item.id===id);
    if(entry&&(entry.name!==name||entry.expectedHash!==expectedHash))throw new SkillTransferError("SKILL_OPERATION_CONFLICT",409);
    const staging=join(this.importRoot,`.remove-${id}`);
    if(entry?.complete){rmSync(staging,{recursive:true,force:true});return {removed:entry.removed,unchanged:true};}
    if(entry&&this.packageInRoot(this.importRoot,name)){
      const info=lstatSync(join(this.importRoot,name),{bigint:true});if(entry.identity!==`${info.dev}:${info.ino}`)throw new SkillTransferError("SKILL_NAME_CONFLICT",409);
    }
    if(entry&&lstatOrNull(staging)){entry.complete=true;this.saveRemovalJournal(journal);rmSync(staging,{recursive:true,force:true});return {removed:true,unchanged:false};}
    const current=this.packageInRoot(this.importRoot,name);
    if(!entry){
      if(journal.entries.length>=500){const completed=journal.entries.findIndex(item=>item.complete);if(completed<0)throw new SkillTransferError("SKILL_OPERATION_JOURNAL_FULL");journal.entries.splice(completed,1);}
      const info=current&&lstatSync(join(this.importRoot,name),{bigint:true});entry={id,name,expectedHash,identity:info?`${info.dev}:${info.ino}`:"missing",removed:!!current,complete:!current};journal.entries.push(entry);this.saveRemovalJournal(journal);
    }
    if(!current)return {removed:false,unchanged:true};
    if(current.hash!==expectedHash)throw new SkillTransferError("SKILL_NAME_CONFLICT",409);
    renameSync(join(this.importRoot,name),staging);entry.complete=true;this.saveRemovalJournal(journal);rmSync(staging,{recursive:true,force:true});return {removed:true,unchanged:false};
  }

  private safeRoot(root: string) {
    try {
      const info = lstatSync(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new SkillTransferError("UNSAFE_SKILL_PACKAGE");
      const real = realpathSync(root);
      if (real !== this.stateRoot && !real.startsWith(this.stateRoot + sep)) throw new SkillTransferError("UNSAFE_SKILL_PACKAGE");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

function readPackage(directory: string, name: string): ValidatedSkill {
  const files: ValidatedSkill["files"] = [];
  let bytes = 0;
  const visit = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === MARKER) {
        if (!lstatSync(join(current, entry.name)).isFile()) throw new SkillTransferError("UNSAFE_SKILL_PACKAGE");
        continue;
      }
      validatePath(relative);
      const path = join(current, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new SkillTransferError("UNSAFE_SKILL_PACKAGE");
      if (info.isDirectory()) { visit(path, relative); continue; }
      if (!info.isFile()) throw new SkillTransferError("UNSAFE_SKILL_PACKAGE");
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let content: Buffer;
      try {
        if (!fstatSync(fd).isFile()) throw new SkillTransferError("UNSAFE_SKILL_PACKAGE");
        content = readFileSync(fd);
      } finally { closeSync(fd); }
      if (portableSkillCredentialRisk(relative, content)) throw new SkillTransferError("SKILL_CREDENTIAL_RISK");
      bytes += content.length;
      if (bytes > MAX_BYTES || files.length >= MAX_FILES) throw new SkillTransferError("SKILL_BUNDLE_TOO_LARGE", 413);
      files.push({ path: relative, bytes: content, sha256: digest(content) });
    }
  };
  visit(directory, "");
  const skillMarkdown = files.find(file => file.path === "SKILL.md");
  if (!skillMarkdown) throw new SkillTransferError("INVALID_SKILL_PACKAGE");
  validateSkillMarkdown(skillMarkdown.bytes);
  return { name, files, hash: skillHash(name, files) };
}

function validateManifest(raw: unknown): ValidatedSkill[] {
  const manifest = manifestSchema.parse(raw);
  let totalBytes = 0;
  let totalFiles = 0;
  return manifest.skills.map(skill => {
    const paths = new Set<string>();
    const files = skill.files.map(file => {
      validatePath(file.path);
      if (paths.has(file.path)) throw new SkillTransferError("DUPLICATE_SKILL_PATH");
      paths.add(file.path);
      const bytes = decodeBase64(file.data);
      if (portableSkillCredentialRisk(file.path, bytes)) throw new SkillTransferError("SKILL_CREDENTIAL_RISK");
      totalBytes += bytes.length; totalFiles++;
      if (totalBytes > MAX_BYTES || totalFiles > MAX_FILES) throw new SkillTransferError("SKILL_BUNDLE_TOO_LARGE", 413);
      if (digest(bytes) !== file.sha256) throw new SkillTransferError("SKILL_INTEGRITY_FAILED");
      return { path: file.path, bytes, sha256: file.sha256 };
    }).sort((a, b) => a.path.localeCompare(b.path));
    if (!paths.has("SKILL.md")) throw new SkillTransferError("INVALID_SKILL_PACKAGE");
    validateSkillMarkdown(files.find(file => file.path === "SKILL.md")!.bytes);
    return { name: skill.name, files, hash: skillHash(skill.name, files) };
  });
}

function validatePath(path: string) {
  if (path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path) || posix.normalize(path) !== path || path.split("/").some(part => !part || part === "." || part === ".." || denied(part)) || portableSkillCredentialRisk(path,new Uint8Array())) {
    throw new SkillTransferError("UNSAFE_SKILL_PATH");
  }
}
function denied(part: string) {
  const value = part.toLowerCase();
  return value === MARKER || value === REMOVALS || value === ".env" || value.startsWith(".env.") || value === "auth.json" || value === "cookies" || value === "keys" || value === "node_modules" || value === ".git";
}
/** A deliberately conservative screen for known credential files and obvious plaintext secrets.
 * Skill packages can contain arbitrary bytes, so this is not a universal secret detector. */
export function portableSkillCredentialRisk(path: string, bytes: Uint8Array) {
  const parts = path.split("/").map(part => part.toLowerCase());
  const basename = parts.at(-1) ?? "";
  if (parts.some(part => [".ssh", ".gnupg", ".aws", ".azure"].includes(part))) return true;
  if (["credentials.json", ".npmrc", ".netrc", ".pypirc", ".git-credentials", "auth.json", "token.txt", "tokens.txt",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "cookies", "cookies.sqlite", "login data", "logins.json", "key3.db", "key4.db", "web data", "local state"].includes(basename)) return true;
  if (parts.length > 1 && parts.at(-2) === ".docker" && basename === "config.json") return true;
  if (/^(?:private[-_.]?key|client[-_.]?secret)(?:\.[a-z0-9]+)?$/i.test(basename) || /\.(?:p12|pfx|jks|keystore)$/i.test(basename)) return true;
  const text = Buffer.from(bytes).toString("utf8");
  if (/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/.test(text)) return true;
  if (/(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_live_[A-Za-z0-9]{20,}|sk-(?:ant-[A-Za-z0-9-]+-|proj-)?[A-Za-z0-9_-]{32,}|npm_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35})(?:$|[^A-Za-z0-9_-])/.test(text)) return true;
  if (/(?:_authToken|authorization\s*:\s*bearer)\s*[=:]?\s*["']?[A-Za-z0-9_./+=-]{24,}/i.test(text)) return true;
  const assignment=/(?:api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|password)\s*[=:]\s*["']?([A-Za-z0-9_./+=-]{24,})/ig;
  for(const match of text.matchAll(assignment)){const value=match[1];if(/[a-z]/i.test(value)&&/\d/.test(value)&&!/(?:example|placeholder|redacted|your[_-])/i.test(value))return true;}
  return false;
}
function decodeBase64(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new SkillTransferError("INVALID_SKILL_BUNDLE");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new SkillTransferError("INVALID_SKILL_BUNDLE");
  return bytes;
}
function digest(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function skillHash(name: string, files: ValidatedSkill["files"]) {
  const hash = createHash("sha256").update(`skill\0${name}\0`);
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${file.path}\0${file.sha256}\0${file.bytes.length}\0`);
  return hash.digest("hex");
}
function bundleHash(skills: ValidatedSkill[]) {
  const hash = createHash("sha256").update("skills-v1\0");
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) hash.update(`${skill.name}\0${skill.hash}\0`);
  return hash.digest("hex");
}
function readMarker(directory: string) {
  try {
    const path = join(directory, MARKER);
    if (!lstatSync(path).isFile()) return null;
    const marker = JSON.parse(readFileSync(path, "utf8"));
    return marker?.version === 1 && /^[a-f0-9]{64}$/.test(marker.hash) ? marker.hash as string : null;
  } catch { return null; }
}
function lstatOrNull(path:string){try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}}
function description(files: ValidatedSkill["files"]) {
  const skill = files.find(file => file.path === "SKILL.md")!.bytes.toString("utf8");
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex(line => /^description\s*:/.test(line));
  if (index < 0) return "";
  const value = lines[index].replace(/^description\s*:\s*/, "").trim();
  if (value === "|" || value === ">") return lines.slice(index + 1).filter(line => /^\s+/.test(line)).map(line => line.trim()).join(value === ">" ? " " : "\n").slice(0, 500);
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2").slice(0, 500);
}
function validateSkillMarkdown(bytes: Buffer) {
  if (!bytes.length) throw new SkillTransferError("INVALID_SKILL_PACKAGE");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new SkillTransferError("INVALID_SKILL_PACKAGE"); }
}
