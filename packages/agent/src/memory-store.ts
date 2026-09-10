import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryKind, MemoryRecord, MemoryRequest, MemoryResponse, MemoryScope } from "./memory-protocol";

const MAX_CONTENT_BYTES = 8_000;
const MAX_LEGACY_BYTES = 30_000;
const MAX_STARTUP_BYTES = 4_096;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 1_000;
const FALLBACK_SCAN = 500;
const CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type Stored = {
  id: string; version: number; content: string; scope: MemoryScope; kind: MemoryKind; provenance: string;
  project_key: string | null; mission_id: string | null; expires_at: string | null; reusable: number;
  created_at: string; updated_at: string; explicit: number;
};

export class MemoryStore {
  private db?: Database;
  private readonly memoryDir: string;
  private readonly workspace: string;
  private readonly startupPath: string;
  private readonly templatePath: string;
  private initializationError = false;

  constructor(private readonly stateDir: string) {
    this.memoryDir = join(stateDir, "memory");
    this.workspace = join(stateDir, "workspace");
    this.startupPath = join(this.memoryDir, "startup.json");
    this.templatePath = join(this.workspace, "template-memory.json");
    try {
      safeDirectory(stateDir);
      safeDirectory(this.memoryDir);
      safeDirectory(this.workspace);
      const databasePath = join(this.memoryDir, "memory.sqlite");
      safeRegularOrMissing(databasePath);
      safeRegularOrMissing(`${databasePath}-wal`);
      safeRegularOrMissing(`${databasePath}-shm`);
      this.db = new Database(databasePath, { create: true, strict: true });
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY, version INTEGER NOT NULL, content TEXT NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('user','companion','project')),
          kind TEXT NOT NULL CHECK(kind IN ('fact','preference','correction','procedure','context')),
          provenance TEXT NOT NULL, project_key TEXT, mission_id TEXT, expires_at TEXT,
          reusable INTEGER NOT NULL DEFAULT 0, explicit INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_mutations (
          operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      this.db.exec("CREATE TABLE IF NOT EXISTS memory_index_dirty (id TEXT PRIMARY KEY);");
      this.db.exec(`CREATE INDEX IF NOT EXISTS memory_expiry_idx ON memories(expires_at);
        CREATE INDEX IF NOT EXISTS memory_startup_idx ON memories(updated_at DESC,id)
          WHERE explicit=1 AND scope IN ('user','companion') AND kind IN ('preference','correction');
        CREATE INDEX IF NOT EXISTS memory_template_idx ON memories(updated_at DESC,id)
          WHERE reusable=1;`);
      try { this.ensureIndex(); } catch {}
      this.importTemplateOnce();
    } catch {
      try { this.db?.close(false); } catch {}
      this.db = undefined;
      this.initializationError = true;
    }
  }

  handle(request: MemoryRequest): MemoryResponse {
    if (!this.db || this.initializationError) return unavailable();
    try {
      switch (request.op) {
        case "read": return this.read(request.id, request.missionId);
        case "search": return this.search(request.query, request.projectKey, request.missionId, request.limit);
        case "save": return this.save(request);
        case "delete": return this.delete(request);
        case "maintain": return this.maintain();
        default: return invalid("MEMORY_REQUEST_INVALID");
      }
    } catch {
      return unavailable();
    }
  }

  close(): void {
    try { this.db?.close(false); } finally { this.db = undefined; }
  }

  private read(id: string, missionId?: string): MemoryResponse {
    if (!validId(id) || (missionId !== undefined && !validText(missionId))) return invalid("MEMORY_REQUEST_INVALID");
    if (id === "legacy-shared-memory") {
      const legacy = this.searchLegacy("", false);
      return legacy ? { status: "ok", memory: legacy } : { status: "ok", memories: [] };
    }
    const row = this.row(id);
    if (!row || expired(row) || (row.kind === "context" && row.mission_id !== missionId)) return { status: "ok", memories: [] };
    return { status: "ok", memory: publicRecord(row) };
  }

  private search(query: string, projectKey?: string, missionId?: string, requestedLimit?: number): MemoryResponse {
    if (!validText(query) || Buffer.byteLength(query, "utf8") > MAX_CONTENT_BYTES ||
      (projectKey !== undefined && !validText(projectKey)) || (missionId !== undefined && !validText(missionId)) ||
      (requestedLimit !== undefined && (!Number.isInteger(requestedLimit) || requestedLimit < 1))) {
      return invalid("MEMORY_REQUEST_INVALID");
    }
    const limit = Math.min(requestedLimit ?? MAX_RESULTS, MAX_RESULTS);
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    // Scope before limiting: unrelated projects/tasks must not displace visible matches.
    const visibility = `(m.scope!='project' OR m.project_key=?)
      AND (m.kind!='context' OR m.mission_id=?) AND (m.expires_at IS NULL OR m.expires_at>?)`;
    const visibilityParams = [projectKey ?? null, missionId ?? null, new Date().toISOString()];
    let rows: Stored[];
    let partial = false;
    try {
      if (!terms.length || this.indexDirty()) throw new Error("fallback");
      const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
      rows = this.db!.query(`SELECT m.* FROM memory_fts f JOIN memories m ON m.id=f.id
        WHERE memory_fts MATCH ? AND ${visibility} ORDER BY bm25(memory_fts),m.updated_at DESC LIMIT ?`)
        .all(expression, ...visibilityParams, limit) as Stored[];
    } catch {
      rows = this.db!.query(`SELECT m.* FROM memories m WHERE ${visibility} ORDER BY m.updated_at DESC LIMIT ?`)
        .all(...visibilityParams, FALLBACK_SCAN) as Stored[];
      partial = rows.length === FALLBACK_SCAN;
      const needles = terms.length ? terms.map(term => term.toLocaleLowerCase()) : [query.toLocaleLowerCase()];
      rows = rows.filter(row => needles.every(term => row.content.toLocaleLowerCase().includes(term)));
    }
    const memories = rows.filter(row => visible(row, projectKey, missionId)).slice(0, limit).map(row => {
      const record = publicRecord(row);
      record.content = snippet(record.content, query);
      return record;
    });
    if (memories.length < limit) {
      const legacy = this.searchLegacy(query, true);
      if (legacy) memories.push(legacy);
    }
    return { status: "ok", memories: memories.slice(0, limit), ...(partial ? { partial: true } : {}) };
  }

  private save(request: Extract<MemoryRequest, { op: "save" }>): MemoryResponse {
    const normalized = validateSave(request);
    if (typeof normalized === "string") return invalid(normalized);
    const hash = requestHash(request);
    const result = this.db!.transaction(() => {
      const receipt = this.receipt(request.operationId, hash);
      if (receipt) return receipt;
      const now = new Date().toISOString();
      const id = request.id ?? randomUUID();
      const current = this.row(id);
      let response: MemoryResponse;
      if (current) {
        const inaccessible = current.kind === "context" && current.mission_id !== request.missionId;
        if (inaccessible || request.expectedVersion === undefined || request.expectedVersion !== current.version) {
          response = { status: "conflict", error: "MEMORY_VERSION_CONFLICT",
            ...(!inaccessible ? { memory: publicRecord(current) } : {}) };
        } else {
          const version = current.version + 1;
          this.db!.query(`UPDATE memories SET version=?,content=?,scope=?,kind=?,provenance=?,project_key=?,mission_id=?,
            expires_at=?,reusable=?,explicit=1,updated_at=? WHERE id=? AND version=?`)
            .run(version, normalized.content, normalized.scope, normalized.kind, normalized.provenance,
              normalized.projectKey, normalized.missionId, normalized.expiresAt, normalized.reusable ? 1 : 0,
              now, id, request.expectedVersion);
          this.db!.query("INSERT INTO memory_index_dirty(id) VALUES(?) ON CONFLICT DO NOTHING").run(id);
          response = { status: "ok", memory: publicRecord(this.row(id)!) };
        }
      } else if (request.id || request.expectedVersion !== undefined) {
        response = { status: "conflict", error: "MEMORY_VERSION_CONFLICT" };
      } else {
        this.db!.query(`INSERT INTO memories
          (id,version,content,scope,kind,provenance,project_key,mission_id,expires_at,reusable,explicit,created_at,updated_at)
          VALUES(?,1,?,?,?,?,?,?,?,?,1,?,?)`)
          .run(id, normalized.content, normalized.scope, normalized.kind, normalized.provenance,
            normalized.projectKey, normalized.missionId, normalized.expiresAt, normalized.reusable ? 1 : 0, now, now);
        this.db!.query("INSERT INTO memory_index_dirty(id) VALUES(?) ON CONFLICT DO NOTHING").run(id);
        response = { status: "ok", memory: publicRecord(this.row(id)!) };
      }
      this.storeReceipt(request.operationId, hash, response, now);
      return response;
    }).immediate() as MemoryResponse;
    if (result.status === "ok" && "memory" in result) this.refreshDerivatives(result.memory.id);
    return result;
  }

  private delete(request: Extract<MemoryRequest, { op: "delete" }>): MemoryResponse {
    if (!validId(request.operationId) || !validId(request.id) || !Number.isInteger(request.expectedVersion) || request.expectedVersion < 1 ||
      (request.missionId !== undefined && !validText(request.missionId)))
      return invalid("MEMORY_REQUEST_INVALID");
    const hash = requestHash(request);
    const result = this.db!.transaction(() => {
      const receipt = this.receipt(request.operationId, hash);
      if (receipt) return receipt;
      const current = this.row(request.id);
      let response: MemoryResponse;
      const inaccessible = current?.kind === "context" && current.mission_id !== request.missionId;
      if (!current || current.version !== request.expectedVersion || inaccessible) {
        response = { status: "conflict", error: "MEMORY_VERSION_CONFLICT",
          ...(current && !inaccessible ? { memory: publicRecord(current) } : {}) };
      } else {
        this.db!.query("DELETE FROM memories WHERE id=? AND version=?").run(request.id, request.expectedVersion);
        this.db!.query("INSERT INTO memory_index_dirty(id) VALUES(?) ON CONFLICT DO NOTHING").run(request.id);
        response = { status: "ok", deleted: true };
      }
      this.storeReceipt(request.operationId, hash, response, new Date().toISOString());
      return response;
    }).immediate() as MemoryResponse;
    if (result.status === "ok") this.refreshDerivatives(request.id);
    return result;
  }

  private maintain(): MemoryResponse {
    const expired = this.db!.query(`DELETE FROM memories WHERE id IN
      (SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at<=? LIMIT 100)`)
      .run(new Date().toISOString()).changes;
    let indexMore = false;
    try { this.ensureIndex(); indexMore = this.maintainIndexBatch(); } catch { try { this.markIndexDirty(); } catch {} }
    this.writeSnapshots();
    this.searchLegacy("", false);
    const moreExpired = expired === 100 && !!this.db!.query("SELECT 1 FROM memories WHERE expires_at IS NOT NULL AND expires_at<=? LIMIT 1")
      .get(new Date().toISOString());
    return moreExpired || indexMore ? { status: "ok", more: true } : { status: "ok" };
  }

  private row(id: string): Stored | null {
    return this.db!.query("SELECT * FROM memories WHERE id=?").get(id) as Stored | null;
  }

  private receipt(operationId: string, hash: string): MemoryResponse | null {
    const row = this.db!.query("SELECT request_hash,response_json FROM memory_mutations WHERE operation_id=?")
      .get(operationId) as { request_hash: string; response_json: string } | null;
    if (!row) return null;
    return row.request_hash === hash ? JSON.parse(row.response_json) as MemoryResponse
      : { status: "conflict", error: "MEMORY_OPERATION_CONFLICT" };
  }

  private storeReceipt(operationId: string, hash: string, response: MemoryResponse, now: string): void {
    this.db!.query("INSERT INTO memory_mutations(operation_id,request_hash,response_json,created_at) VALUES(?,?,?,?)")
      .run(operationId, hash, JSON.stringify(response), now);
  }

  private ensureIndex(): void {
    this.db!.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,content,tokenize='unicode61')");
    if (this.db!.query("SELECT 1 FROM memory_meta WHERE key='fts_cursor'").get()) return;
    const count = (this.db!.query("SELECT count(*) AS count FROM memory_fts").get() as { count: number }).count;
    const records = (this.db!.query("SELECT count(*) AS count FROM memories").get() as { count: number }).count;
    if (count !== records) this.beginIndexRebuild();
  }

  private beginIndexRebuild(): void {
    this.db!.transaction(() => {
      this.db!.exec("DROP TABLE IF EXISTS memory_fts");
      this.db!.exec("CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED,content,tokenize='unicode61')");
      this.db!.query("INSERT INTO memory_meta(key,value) VALUES('fts_cursor','') ON CONFLICT(key) DO UPDATE SET value='' ").run();
    }).immediate();
  }

  private maintainIndexBatch(): boolean {
    this.db!.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,content,tokenize='unicode61')");
    const dirty = this.db!.query("SELECT id FROM memory_index_dirty ORDER BY id LIMIT 100")
      .all() as Array<{ id: string }>;
    if (dirty.length) this.db!.transaction(() => {
      for (const entry of dirty) {
        this.db!.query("DELETE FROM memory_fts WHERE id=?").run(entry.id);
        const row = this.row(entry.id);
        if (row) this.db!.query("INSERT INTO memory_fts(id,content) VALUES(?,?)").run(row.id, row.content);
        this.db!.query("DELETE FROM memory_index_dirty WHERE id=?").run(entry.id);
      }
    }).immediate();
    if (dirty.length === 100) return true;
    const meta = this.db!.query("SELECT value FROM memory_meta WHERE key='fts_cursor'").get() as { value: string } | null;
    if (!meta) return false;
    const batchSize = 100 - dirty.length;
    const rows = this.db!.query("SELECT id,content FROM memories WHERE id>? ORDER BY id LIMIT ?")
      .all(meta.value, batchSize) as Array<{ id: string; content: string }>;
    this.db!.transaction(() => {
      for (const row of rows) {
        this.db!.query("DELETE FROM memory_fts WHERE id=?").run(row.id);
        this.db!.query("INSERT INTO memory_fts(id,content) VALUES(?,?)").run(row.id, row.content);
      }
      if (rows.length < batchSize) this.db!.query("DELETE FROM memory_meta WHERE key='fts_cursor'").run();
      else this.db!.query("UPDATE memory_meta SET value=? WHERE key='fts_cursor'").run(rows.at(-1)!.id);
    }).immediate();
    return rows.length === batchSize;
  }

  private indexDirty(): boolean {
    return !!this.db!.query(`SELECT 1 FROM memory_meta WHERE key='fts_cursor'
      UNION ALL SELECT 1 FROM memory_index_dirty LIMIT 1`).get();
  }

  private markIndexDirty(): void {
    this.db!.query("INSERT INTO memory_meta(key,value) VALUES('fts_cursor','') ON CONFLICT(key) DO NOTHING").run();
  }

  private refreshDerivatives(id: string): void {
    try {
      this.db!.transaction(() => {
        this.db!.query("DELETE FROM memory_fts WHERE id=?").run(id);
        const row = this.row(id);
        if (row) this.db!.query("INSERT INTO memory_fts(id,content) VALUES(?,?)").run(id, row.content);
        this.db!.query("DELETE FROM memory_index_dirty WHERE id=?").run(id);
      }).immediate();
    } catch { try { this.beginIndexRebuild(); } catch { try { this.markIndexDirty(); } catch {} } }
    this.writeSnapshots();
  }

  private writeSnapshots(): void {
    const now = new Date().toISOString();
    const startup = (this.db!.query(`SELECT * FROM memories WHERE explicit=1
      AND scope IN ('user','companion') AND kind IN ('preference','correction')
      AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC,id LIMIT 100`).all(now) as Stored[])
      .map(snapshotRecord);
    const reusable = (this.db!.query(`SELECT * FROM memories WHERE reusable=1
      AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC,id LIMIT 200`).all(now) as Stored[])
      .map(templateRecord);
    try { atomicBoundedJson(this.memoryDir, this.startupPath, "memories", startup, MAX_STARTUP_BYTES); } catch {}
    try { atomicBoundedJson(this.workspace, this.templatePath, "memories", reusable, MAX_TEMPLATE_BYTES, { version: 1 }); } catch {}
  }

  private importTemplateOnce(): void {
    if (this.db!.query("SELECT value FROM memory_meta WHERE key='template_imported'").get()) return;
    // Absence is also a completed import decision. A stale derived export must never become
    // a new source after a committed delete leaves this Companion's durable store empty.
    const markImported = () => this.db!.query("INSERT INTO memory_meta(key,value) VALUES('template_imported','1') ON CONFLICT DO NOTHING").run();
    const existing = this.db!.query("SELECT count(*) AS count FROM memories").get() as { count: number };
    if (existing.count) { markImported(); return; }
    let document: unknown;
    try {
      safeRegularOrMissing(this.templatePath);
      if (lstatSync(this.templatePath).size > MAX_TEMPLATE_BYTES) throw new Error("large");
      const bytes = readFileSync(this.templatePath);
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      markImported();
      return;
    }
    const candidates = document && typeof document === "object" && (document as any).version === 1 && Array.isArray((document as any).memories)
      ? (document as any).memories.slice(0, 100) : [];
    this.db!.transaction(() => {
      const now = new Date().toISOString();
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const request: Extract<MemoryRequest, { op: "save" }> = {
          op: "save", operationId: "import", content: candidate.content,
          scope: candidate.scope, kind: candidate.kind, provenance: candidate.provenance,
          projectKey: candidate.projectKey, expiresAt: candidate.expiresAt, reusable: candidate.reusable,
        };
        const value = validateSave(request);
        if (typeof value === "string" || !value.reusable || value.scope === "user" || value.kind === "context") continue;
        const id = randomUUID();
        this.db!.query(`INSERT INTO memories
          (id,version,content,scope,kind,provenance,project_key,mission_id,expires_at,reusable,explicit,created_at,updated_at)
          VALUES(?,1,?,?,?,?,?,?,?,1,0,?,?)`)
          .run(id, value.content, value.scope, value.kind, value.provenance, value.projectKey, value.missionId, value.expiresAt, now, now);
      }
      this.db!.query("INSERT INTO memory_meta(key,value) VALUES('template_imported','1')").run();
    }).immediate();
    try { this.beginIndexRebuild(); this.maintainIndexBatch(); } catch { try { this.markIndexDirty(); } catch {} }
    this.writeSnapshots();
  }

  private searchLegacy(query: string, truncate: boolean): MemoryRecord | null {
    const path = join(this.workspace, "MEMORY.md");
    try {
      safeRegularOrMissing(path);
      const info = lstatSync(path);
      if (info.size > MAX_LEGACY_BYTES) return null;
      const bytes = readFileSync(path);
      const content = bytes.toString("utf8");
      const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      let matches = terms.every(term => content.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
      // MEMORY.md stays authoritative. Refresh its separate, disposable index only in this
      // worker, after bounded retrieval, including replacements made by the legacy CAS tool.
      const digest = createHash("sha256").update(bytes).digest("hex");
      try {
        this.db!.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_legacy_fts USING fts5(content,tokenize='unicode61')");
        const indexed = this.db!.query("SELECT value FROM memory_meta WHERE key='legacy_digest'").get() as { value: string } | null;
        const present = this.db!.query("SELECT 1 FROM memory_legacy_fts LIMIT 1").get();
        if (indexed?.value !== digest || !present) this.db!.transaction(() => {
          this.db!.exec("DELETE FROM memory_legacy_fts");
          this.db!.query("INSERT INTO memory_legacy_fts(content) VALUES(?)").run(content);
          this.db!.query("INSERT INTO memory_meta(key,value) VALUES('legacy_digest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(digest);
        }).immediate();
        if (terms.length) matches = !!this.db!.query("SELECT 1 FROM memory_legacy_fts WHERE memory_legacy_fts MATCH ? LIMIT 1")
          .get(terms.map(term => `"${term}"`).join(" AND "));
      } catch {
        // Preserve the file and use the bounded fallback for this request; rebuild next time.
        try { this.db!.exec("DROP TABLE IF EXISTS memory_legacy_fts; DELETE FROM memory_meta WHERE key='legacy_digest'"); } catch {}
      }
      if (!matches) return null;
      const timestamp = new Date(info.mtimeMs).toISOString();
      return { id: "legacy-shared-memory", version: 1, content: truncate ? snippet(content, query) : content, scope: "companion",
        kind: "fact", provenance: "legacy MEMORY.md", createdAt: timestamp, updatedAt: timestamp, reusable: false };
    } catch { return null; }
  }
}

function validateSave(request: Extract<MemoryRequest, { op: "save" }>): string | {
  content: string; scope: MemoryScope; kind: MemoryKind; provenance: string; projectKey: string | null;
  missionId: string | null; expiresAt: string | null; reusable: boolean;
} {
  if (!validId(request.operationId) || (request.id !== undefined && !validId(request.id)) ||
    (request.expectedVersion !== undefined && (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1)) ||
    !validText(request.content) || Buffer.byteLength(request.content, "utf8") > MAX_CONTENT_BYTES ||
    !["user", "companion", "project"].includes(request.scope) ||
    !["fact", "preference", "correction", "procedure", "context"].includes(request.kind) ||
    !validText(request.provenance) || request.provenance.length > 1_000 ||
    (request.projectKey !== undefined && request.projectKey.length > 200)) return "MEMORY_REQUEST_INVALID";
  if (request.id === undefined && request.expectedVersion !== undefined) return "MEMORY_REQUEST_INVALID";
  if (request.scope === "project" ? !validText(request.projectKey) : request.projectKey !== undefined) return "MEMORY_SCOPE_INVALID";
  if (request.kind === "context" ? !validText(request.missionId) : request.missionId !== undefined) return "MEMORY_CONTEXT_INVALID";
  let expiresAt = request.expiresAt ?? null;
  if (expiresAt !== null && (!validText(expiresAt) || !Number.isFinite(Date.parse(expiresAt)))) return "MEMORY_EXPIRY_INVALID";
  if (expiresAt !== null) expiresAt = new Date(expiresAt).toISOString();
  if (request.kind === "context" && expiresAt === null) expiresAt = new Date(Date.now() + CONTEXT_TTL_MS).toISOString();
  const reusable = request.reusable ?? false;
  const allowedReusable = (request.scope === "project" && (request.kind === "fact" || request.kind === "procedure")) ||
    (request.scope === "companion" && request.kind === "procedure");
  if (reusable && !allowedReusable) return "MEMORY_REUSABLE_INVALID";
  return { content: request.content, scope: request.scope, kind: request.kind, provenance: request.provenance,
    projectKey: request.projectKey ?? null, missionId: request.missionId ?? null, expiresAt, reusable };
}

function publicRecord(row: Stored): MemoryRecord {
  return { id: row.id, version: row.version, content: row.content, scope: row.scope, kind: row.kind,
    provenance: row.provenance, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.project_key ? { projectKey: row.project_key } : {}), ...(row.mission_id ? { missionId: row.mission_id } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}), reusable: !!row.reusable };
}

function snapshotRecord(row: Stored) {
  const value: Record<string, unknown> = { id: row.id, version: row.version, scope: row.scope, kind: row.kind, content: row.content };
  if (row.expires_at) value.expiresAt = row.expires_at;
  return value;
}

function templateRecord(row: Stored) {
  return { content: row.content, scope: row.scope, kind: row.kind, provenance: row.provenance,
    ...(row.project_key ? { projectKey: row.project_key } : {}), ...(row.expires_at ? { expiresAt: row.expires_at } : {}), reusable: true };
}

function visible(row: Stored, projectKey?: string, missionId?: string): boolean {
  if (expired(row)) return false;
  if (row.kind === "context" && row.mission_id !== missionId) return false;
  if (row.scope === "project" && row.project_key !== projectKey) return false;
  return true;
}

function expired(row: Stored): boolean { return row.expires_at !== null && Date.parse(row.expires_at) <= Date.now(); }
function validText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 10_000; }
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function invalid(error: string): MemoryResponse { return { status: "invalid", error }; }
function unavailable(): MemoryResponse { return { status: "unavailable", error: "MEMORY_UNAVAILABLE" }; }
function requestHash(request: MemoryRequest): string {
  return createHash("sha256").update(JSON.stringify(canonical(request))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

function snippet(content: string, query: string): string {
  if (content.length <= MAX_SNIPPET_CHARS) return content;
  const term = query.match(/[\p{L}\p{N}_]+/u)?.[0]?.toLocaleLowerCase();
  const found = term ? content.toLocaleLowerCase().indexOf(term) : 0;
  const start = Math.max(0, Math.min(content.length - MAX_SNIPPET_CHARS, found - 200));
  return content.slice(start, start + MAX_SNIPPET_CHARS);
}

function safeDirectory(path: string): void {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("MEMORY_PATH_UNSAFE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("MEMORY_PATH_UNSAFE");
  }
}

function safeRegularOrMissing(path: string): void {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("MEMORY_PATH_UNSAFE");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function atomicBoundedJson(directory: string, path: string, key: string, items: unknown[], limit: number,
  prefix: Record<string, unknown> = {}): void {
  safeDirectory(directory);
  safeRegularOrMissing(path);
  const accepted: unknown[] = [];
  for (const item of items) {
    const candidate = JSON.stringify({ ...prefix, [key]: [...accepted, item] });
    if (Buffer.byteLength(candidate, "utf8") > limit) continue;
    accepted.push(item);
  }
  const content = JSON.stringify({ ...prefix, [key]: accepted });
  const temporary = join(directory, `.memory-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
