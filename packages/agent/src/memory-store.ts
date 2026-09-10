import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { replaceLegacyWithReceipt } from "./memory-legacy";
import type {
  MemoryApproval, MemoryAuthority, MemoryCheckpoint, MemoryKind, MemoryLimits, MemoryMission,
  MemoryRecord, MemoryRequest, MemoryResponse, MemoryScope, MemorySource, MemoryStatus,
} from "./memory-protocol";

const MAX_CONTENT_BYTES = 8_000;
const MAX_LEGACY_BYTES = 30_000;
const MAX_STARTUP_BYTES = 4_096;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_RESULTS = 10;
const MAX_INSPECT_RESULTS = 5;
const MAX_LIST_BYTES = 64 * 1024;
const MAX_SNIPPET_CHARS = 1_000;
const FALLBACK_SCAN = 500;
const CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000;
const SCOPE_RECORD_LIMIT = 100;
const SCOPE_BYTE_LIMIT = 128 * 1024;
const RETAINED_RECORD_LIMIT = 500;
const RETAINED_BYTE_LIMIT = 512 * 1024;
const REPOSITORY_GROOM_RECORDS = 10;
const REPOSITORY_GROOM_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type Stored = {
  id: string; version: number; content: string; base_scope: "user" | "companion" | "project"; kind: MemoryKind;
  provenance: string; project_key: string | null; mission_id: string | null; expires_at: string | null;
  reusable: number; created_at: string; updated_at: string; explicit: number;
  lifecycle_scope: MemoryScope | null; status: MemoryStatus | null; approval: MemoryApproval | null;
  asserted_at: string | null; review_after: string | null; source_json: string | null;
  mission_json: string | null; conversation_id: string | null; supersedes_json: string | null;
  superseded_by_json: string | null; uncertain: number | null; verification: "changed" | "missing" | "verified" | null;
  structured_json: string | null;
};

type NormalizedSave = {
  content: string; scope: MemoryScope; baseScope: "user" | "companion" | "project"; kind: MemoryKind;
  provenance: string; source: MemorySource; projectKey: string | null; missionId: string | null;
  mission: MemoryMission | null; conversationId: string | null; assertedAt: string; reviewAfter: string | null;
  expiresAt: string | null; reusable: boolean; uncertain: boolean;
  supersedes: Array<{ id: string; expectedVersion: number }>;
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
        CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_lifecycle (
          id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, approval TEXT NOT NULL,
          asserted_at TEXT NOT NULL, review_after TEXT, source_json TEXT NOT NULL,
          mission_json TEXT, conversation_id TEXT, supersedes_json TEXT NOT NULL DEFAULT '[]',
          superseded_by_json TEXT NOT NULL DEFAULT '[]', uncertain INTEGER NOT NULL DEFAULT 0,
          verification TEXT, structured_json TEXT, version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS memory_completion_tombstones (
          source_type TEXT NOT NULL, source_ref TEXT NOT NULL, observed_at TEXT NOT NULL,
          PRIMARY KEY(source_type,source_ref)
        );
        CREATE TABLE IF NOT EXISTS memory_index_dirty (id TEXT PRIMARY KEY);
        CREATE INDEX IF NOT EXISTS memory_expiry_idx ON memories(expires_at);
        CREATE INDEX IF NOT EXISTS memory_startup_idx ON memories(updated_at DESC,id)
          WHERE explicit=1 AND scope IN ('user','companion') AND kind IN ('preference','correction');
        CREATE INDEX IF NOT EXISTS memory_template_idx ON memories(updated_at DESC,id) WHERE reusable=1;`);
      try { this.db.exec("ALTER TABLE memory_lifecycle ADD COLUMN version INTEGER NOT NULL DEFAULT 1"); } catch {}
      try { this.ensureIndex(); } catch {}
      this.importTemplateOnce();
    } catch {
      try { this.db?.close(false); } catch {}
      this.db = undefined;
      this.initializationError = true;
    }
  }

  handle(request: MemoryRequest, authority: MemoryAuthority = "agent"): MemoryResponse {
    if (!this.db || this.initializationError) return unavailable();
    try {
      switch (request.op) {
        case "read": return this.read(request.id, request.projectKey, request.missionId, request.conversationId);
        case "search": return this.search(request.query, request.projectKey, request.missionId, request.conversationId, request.limit);
        case "save": return this.save(request, authority);
        case "delete": return this.delete(request);
        case "retire": return this.retire(request);
        case "approve": return authority === "human" ? this.approve(request) : forbidden();
        case "adopt_legacy": return authority === "human" ? this.adoptLegacy(request) : forbidden();
        case "legacy_replace": return authority === "human"
          ? replaceLegacyWithReceipt(this.db, this.workspace, request) : forbidden();
        case "observe": return authority === "system" ? this.observe(request) : forbidden();
        case "checkpoint": return this.checkpoint(request, authority);
        case "brief": return this.brief(request.threadId, request.projectKey);
        case "inspect": return this.inspect(request.cursor, request.limit, request.missionsOnly, authority);
        case "maintain": return this.maintain();
        default: return invalid("MEMORY_REQUEST_INVALID");
      }
    } catch {
      return unavailable();
    }
  }

  close(): void { try { this.db?.close(false); } finally { this.db = undefined; } }

  private read(id: string, projectKey?: string, missionId?: string, conversationId?: string): MemoryResponse {
    if (!validId(id) || !validOptionalText(projectKey) || !validOptionalText(missionId) || !validOptionalText(conversationId))
      return invalid("MEMORY_REQUEST_INVALID");
    if (id === "legacy-shared-memory") {
      const legacy = this.searchLegacy("", false);
      return legacy && visibleRecord(legacy, projectKey, missionId, conversationId)
        ? { status: "ok", memory: legacy } : { status: "ok", memories: [] };
    }
    const row = this.row(id);
    if (!row || !visible(row, projectKey, missionId, conversationId)) return { status: "ok", memories: [] };
    return { status: "ok", memory: publicRecord(row) };
  }

  private search(query: string, projectKey?: string, missionId?: string, conversationId?: string,
    requestedLimit?: number): MemoryResponse {
    if (!validText(query) || Buffer.byteLength(query, "utf8") > MAX_CONTENT_BYTES || !validOptionalText(projectKey) ||
      !validOptionalText(missionId) || !validOptionalText(conversationId) ||
      (requestedLimit !== undefined && (!Number.isInteger(requestedLimit) || requestedLimit < 1))) return invalid("MEMORY_REQUEST_INVALID");
    const limit = Math.min(requestedLimit ?? MAX_RESULTS, MAX_RESULTS);
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    let rows: Stored[];
    let partial = false;
    try {
      if (!terms.length || this.indexDirty()) throw new Error("fallback");
      const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
      rows = this.db!.query(`${SELECT_STORED} JOIN memory_fts f ON m.id=f.id
        WHERE memory_fts MATCH ? AND ${VISIBLE_SQL} ORDER BY bm25(memory_fts),m.updated_at DESC LIMIT ?`)
        .all(expression, new Date().toISOString(), projectKey ?? null, missionId ?? null, projectKey ?? null, projectKey ?? null,
          conversationId ?? null, projectKey ?? null, missionId ?? null, FALLBACK_SCAN) as Stored[];
    } catch {
      rows = this.db!.query(`${SELECT_STORED} WHERE ${VISIBLE_SQL} ORDER BY m.updated_at DESC LIMIT ?`)
        .all(new Date().toISOString(), projectKey ?? null, missionId ?? null, projectKey ?? null, projectKey ?? null,
          conversationId ?? null, projectKey ?? null, missionId ?? null, FALLBACK_SCAN) as Stored[];
      partial = rows.length === FALLBACK_SCAN;
      const needles = terms.length ? terms.map(term => term.toLocaleLowerCase()) : [query.toLocaleLowerCase()];
      rows = rows.filter(row => needles.every(term => row.content.toLocaleLowerCase().includes(term)));
    }
    const memories = rows.filter(row => visible(row, projectKey, missionId, conversationId)).slice(0, limit).map(row => {
      const record = publicRecord(row); record.content = snippet(record.content, query); return record;
    });
    if (memories.length < limit) {
      const legacy = this.searchLegacy(query, true);
      if (legacy && visibleRecord(legacy, projectKey, missionId, conversationId)) memories.push(legacy);
    }
    const page = boundedRecords(memories.slice(0, limit));
    return { status: "ok", memories: page, ...(partial || page.length < memories.length ? { partial: true } : {}) };
  }

  private save(request: Extract<MemoryRequest, { op: "save" }>, authority: MemoryAuthority): MemoryResponse {
    const validated = validateSave(request, this.workspace);
    if (typeof validated === "string") return invalid(validated);
    let normalized: NormalizedSave = validated;
    let approval = approvalFor(authority, normalized);
    const hash = requestHash(request);
    let changedIds: string[] = [];
    const result = this.db!.transaction(() => {
      const receipt = this.receipt(request.operationId, hash);
      if (receipt) return receipt;
      const now = new Date().toISOString();
      const id = request.id ?? randomUUID();
      const current = this.row(id);
      let response: MemoryResponse;
      if (current) {
        normalized = preserveOmittedLifecycle(normalized, current, request);
        approval = approvalFor(authority, normalized);
        if (this.completed(normalized)) {
          response = { status: "conflict", error: "MEMORY_SOURCE_COMPLETED" };
          this.storeReceipt(request.operationId, hash, response, now);
          return response;
        }
        const inaccessible = current.kind === "context" &&
          ((current.mission_id !== null && current.mission_id !== normalized.missionId) ||
           (current.conversation_id !== null && current.conversation_id !== normalized.conversationId));
        if (effectiveStatus(current) !== "active" || request.expectedVersion === undefined || request.expectedVersion !== current.version ||
          !sameIdentity(current, normalized)) response = { status: "conflict", error: "MEMORY_VERSION_CONFLICT",
            ...(!inaccessible ? { memory: publicRecord(current) } : {}) };
        else {
          const targetError = this.validateSupersedes(id, normalized, approval);
          if (targetError) response = targetError;
          else {
            const budget = this.checkBudget(normalized, normalized.content, id, approval);
            if (budget) { response = budget; this.storeReceipt(request.operationId, hash, response, now); return response; }
            const version = current.version + 1;
            this.db!.query(`UPDATE memories SET version=?,content=?,scope=?,kind=?,provenance=?,project_key=?,mission_id=?,
              expires_at=?,reusable=?,explicit=1,updated_at=? WHERE id=? AND version=?`)
              .run(version, normalized.content, normalized.baseScope, normalized.kind, normalized.provenance,
                normalized.projectKey, normalized.missionId, normalized.expiresAt, normalized.reusable ? 1 : 0, now, id, request.expectedVersion);
            this.upsertLifecycle(id, normalized, approval);
            if (request.source === undefined && current.verification)
              this.db!.query("UPDATE memory_lifecycle SET verification=? WHERE id=?").run(current.verification, id);
            changedIds = [id, ...this.applySupersedes(id, normalized, approval, now)];
            response = { status: "ok", memory: publicRecord(this.row(id)!) };
          }
        }
      } else if (request.id || request.expectedVersion !== undefined) response = { status: "conflict", error: "MEMORY_VERSION_CONFLICT" };
      else {
        if (this.completed(normalized)) {
          response = { status: "conflict", error: "MEMORY_SOURCE_COMPLETED" };
          this.storeReceipt(request.operationId, hash, response, now);
          return response;
        }
        const targetError = this.validateSupersedes(id, normalized, approval);
        const budget = targetError ? null : this.checkBudget(normalized, normalized.content, undefined, approval);
        if (targetError) response = targetError;
        else if (budget) response = budget;
        else {
          this.db!.query(`INSERT INTO memories
            (id,version,content,scope,kind,provenance,project_key,mission_id,expires_at,reusable,explicit,created_at,updated_at)
            VALUES(?,1,?,?,?,?,?,?,?,?,1,?,?)`)
            .run(id, normalized.content, normalized.baseScope, normalized.kind, normalized.provenance,
              normalized.projectKey, normalized.missionId, normalized.expiresAt, normalized.reusable ? 1 : 0, now, now);
          this.upsertLifecycle(id, normalized, approval);
          changedIds = [id, ...this.applySupersedes(id, normalized, approval, now)];
          response = { status: "ok", memory: publicRecord(this.row(id)!) };
        }
      }
      this.storeReceipt(request.operationId, hash, response, now);
      return response;
    }).immediate() as MemoryResponse;
    for (const id of changedIds) this.refreshDerivatives(id);
    return result;
  }

  private validateSupersedes(id: string, value: NormalizedSave, approval: MemoryApproval): MemoryResponse | null {
    const seen = new Set<string>();
    for (const link of value.supersedes) {
      if (link.id === id || seen.has(link.id)) return invalid("MEMORY_SUPERSEDES_INVALID");
      seen.add(link.id);
      const row = this.row(link.id);
      const alreadyLinked = !!row && effectiveStatus(row) === "superseded" && parseSupersededBy(row).includes(id);
      if (!row || (!alreadyLinked && row.version !== link.expectedVersion) ||
        (!alreadyLinked && effectiveStatus(row) !== "active") || effectiveApproval(row) !== "approved" ||
        scopeKey(row) !== normalizedScopeKey(value)) return { status: "conflict", error: "MEMORY_VERSION_CONFLICT", ...(row ? { memory: publicRecord(row) } : {}) };
    }
    return null;
  }

  private applySupersedes(id: string, value: NormalizedSave, approval: MemoryApproval, now: string): string[] {
    if (approval !== "approved") return [];
    const changed: string[] = [];
    for (const link of value.supersedes) {
      const row = this.row(link.id)!;
      if (effectiveStatus(row) === "superseded" && parseSupersededBy(row).includes(id)) continue;
      this.ensureLifecycle(row);
      const by = [...new Set([...parseSupersededBy(row), id])];
      this.db!.query("UPDATE memory_lifecycle SET status='superseded',superseded_by_json=? WHERE id=?").run(JSON.stringify(by), link.id);
      this.db!.query("UPDATE memories SET version=version+1,updated_at=? WHERE id=?").run(now, link.id);
      changed.push(link.id);
    }
    return changed;
  }

  private upsertLifecycle(id: string, value: NormalizedSave, approval: MemoryApproval, structured?: MemoryCheckpoint): void {
    this.db!.query(`INSERT INTO memory_lifecycle
      (id,scope,status,approval,asserted_at,review_after,source_json,mission_json,conversation_id,supersedes_json,
       superseded_by_json,uncertain,verification,structured_json)
      VALUES(?,?,'active',?,?,?,?,?,?,?,'[]',?,NULL,?)
      ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,status='active',approval=excluded.approval,
      asserted_at=excluded.asserted_at,review_after=excluded.review_after,source_json=excluded.source_json,
      mission_json=excluded.mission_json,conversation_id=excluded.conversation_id,
      supersedes_json=excluded.supersedes_json,uncertain=excluded.uncertain,verification=NULL,
      structured_json=excluded.structured_json`)
      .run(id, value.scope, approval, value.assertedAt, value.reviewAfter, JSON.stringify(value.source),
        value.mission ? JSON.stringify(value.mission) : null, value.conversationId,
        JSON.stringify(value.supersedes), value.uncertain ? 1 : 0, structured ? JSON.stringify(structured) : null);
    this.db!.query("INSERT INTO memory_index_dirty(id) VALUES(?) ON CONFLICT DO NOTHING").run(id);
  }

  private delete(request: Extract<MemoryRequest, { op: "delete" }>): MemoryResponse {
    if (!validMutationTarget(request)) return invalid("MEMORY_REQUEST_INVALID");
    return this.mutation(request, () => {
      const current = this.row(request.id);
      const inaccessible = current?.kind === "context" && current.mission_id !== (request as any).missionId;
      if (!current || current.version !== request.expectedVersion || inaccessible)
        return { status: "conflict", error: "MEMORY_VERSION_CONFLICT", ...(current && !inaccessible ? { memory: publicRecord(current) } : {}) };
      this.db!.query("DELETE FROM memory_lifecycle WHERE id=?").run(request.id);
      this.db!.query("DELETE FROM memories WHERE id=? AND version=?").run(request.id, request.expectedVersion);
      this.db!.query("INSERT INTO memory_index_dirty(id) VALUES(?) ON CONFLICT DO NOTHING").run(request.id);
      return { status: "ok", deleted: true };
    }, request.id);
  }

  private retire(request: Extract<MemoryRequest, { op: "retire" }>): MemoryResponse {
    if (!validMutationTarget(request)) return invalid("MEMORY_REQUEST_INVALID");
    if (request.id === "legacy-shared-memory") return this.retireLegacy(request);
    return this.mutation(request, () => {
      const row = this.row(request.id);
      if (!row || row.version !== request.expectedVersion || effectiveStatus(row) !== "active")
        return { status: "conflict", error: "MEMORY_VERSION_CONFLICT", ...(row ? { memory: publicRecord(row) } : {}) };
      this.ensureLifecycle(row);
      this.db!.query("UPDATE memory_lifecycle SET status='retired' WHERE id=?").run(row.id);
      this.db!.query("UPDATE memories SET version=version+1,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
      return { status: "ok", memory: publicRecord(this.row(row.id)!) };
    }, request.id);
  }

  private approve(request: Extract<MemoryRequest, { op: "approve" }>): MemoryResponse {
    if (!validMutationTarget(request)) return invalid("MEMORY_REQUEST_INVALID");
    return this.mutation(request, () => {
      const row = this.row(request.id);
      if (!row || row.version !== request.expectedVersion || effectiveStatus(row) !== "active" || effectiveApproval(row) !== "pending")
        return { status: "conflict", error: "MEMORY_VERSION_CONFLICT", ...(row ? { memory: publicRecord(row) } : {}) };
      const normalized = normalizedFromRow(row);
      if (this.completed(normalized)) return { status: "conflict", error: "MEMORY_SOURCE_COMPLETED" };
      const targets = this.validateSupersedes(row.id, normalized, "approved");
      if (targets) return targets;
      const budget = this.checkBudget(normalized, row.content, row.id, "approved");
      if (budget) return budget;
      this.db!.query("UPDATE memory_lifecycle SET approval='approved',uncertain=0 WHERE id=?").run(row.id);
      this.db!.query("UPDATE memories SET version=version+1,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
      this.applySupersedes(row.id, normalized, "approved", new Date().toISOString());
      return { status: "ok", memory: publicRecord(this.row(row.id)!) };
    }, request.id);
  }

  private adoptLegacy(request: Extract<MemoryRequest, { op: "adopt_legacy" }>): MemoryResponse {
    if (!validId(request.operationId) || (request.source && validateSource(request.source))) return invalid("MEMORY_REQUEST_INVALID");
    const hash = requestHash(request);
    return this.db!.transaction(() => {
      const receipt = this.receipt(request.operationId, hash); if (receipt) return receipt;
      const legacy = this.searchLegacy("", false);
      let response: MemoryResponse;
      if (!legacy) response = invalid("MEMORY_LEGACY_MISSING");
      else {
        const existing = this.lifecycle("legacy-shared-memory");
        if (!existing) {
          const digest = createHash("sha256").update(legacy.content).digest("hex");
          const source = request.source ?? { type: "repository" as const, ref: "MEMORY.md", revision: digest };
          this.db!.query(`INSERT INTO memory_lifecycle
            (id,scope,status,approval,asserted_at,source_json,supersedes_json,superseded_by_json,uncertain)
            VALUES('legacy-shared-memory','companion','active','approved',?,?,'[]','[]',0)`)
            .run(new Date().toISOString(), JSON.stringify(source));
          this.db!.query("INSERT INTO memory_meta(key,value) VALUES('legacy-lifecycle-digest',?)").run(digest);
        }
        response = { status: "ok", memory: this.searchLegacy("", false)! };
      }
      this.storeReceipt(request.operationId, hash, response, new Date().toISOString());
      return response;
    }).immediate() as MemoryResponse;
  }

  private retireLegacy(request: Extract<MemoryRequest, { op: "retire" }>): MemoryResponse {
    return this.mutation(request, () => {
      const legacy = this.searchLegacy("", false);
      if (!legacy || legacy.version !== request.expectedVersion || legacy.status !== "active")
        return { status: "conflict", error: "MEMORY_VERSION_CONFLICT", ...(legacy ? { memory: legacy } : {}) };
      const lifecycle = this.lifecycle("legacy-shared-memory");
      if (!lifecycle) return invalid("MEMORY_LEGACY_NOT_ADOPTED");
      const tracked = this.db!.query("SELECT value FROM memory_meta WHERE key='legacy-lifecycle-digest'").get() as { value: string } | null;
      const currentDigest = createHash("sha256").update(legacy.content).digest("hex");
      if (!tracked || tracked.value !== currentDigest)
        return { status: "conflict", error: "MEMORY_VERSION_CONFLICT", memory: legacy };
      this.db!.query("UPDATE memory_lifecycle SET status='retired',version=version+1 WHERE id='legacy-shared-memory'").run();
      return { status: "ok", memory: this.searchLegacy("", false)! };
    });
  }

  private observe(request: Extract<MemoryRequest, { op: "observe" }>): MemoryResponse {
    if (!validId(request.operationId) || validateSource({ ...request.source, ...(request.revision ? { revision: request.revision } : {}) }))
      return invalid("MEMORY_REQUEST_INVALID");
    const hash = requestHash(request);
    return this.db!.transaction(() => {
      const receipt = this.receipt(request.operationId, hash); if (receipt) return receipt;
      const now = new Date().toISOString();
      let retired = 0;
      const observedSource = normalizedSource(request.source);
      if (request.state === "completed" || request.state === "merged") {
        this.db!.query(`INSERT INTO memory_completion_tombstones(source_type,source_ref,observed_at) VALUES(?,?,?)
          ON CONFLICT(source_type,source_ref) DO UPDATE SET observed_at=excluded.observed_at`)
          .run(observedSource.type, observedSource.ref, now);
      }
      const rows = this.db!.query(SELECT_STORED).all() as Stored[];
      for (const row of rows) {
        if (!sourceMatches(row, observedSource, request.state)) continue;
        this.ensureLifecycle(row);
        if (request.state === "completed" || request.state === "merged") {
          if (effectiveStatus(row) === "active") {
            this.db!.query("UPDATE memory_lifecycle SET status='retired' WHERE id=?").run(row.id);
            this.db!.query("UPDATE memories SET version=version+1,updated_at=? WHERE id=?").run(now, row.id);
            retired++;
          }
        } else {
          if (request.state === "verified") {
            const source = effectiveSource(row);
            const revision = request.revision ?? (source.type === "repository"
              ? repositoryRevision(this.workspace, source.ref, REPOSITORY_GROOM_BYTES).revision : undefined);
            this.db!.query("UPDATE memory_lifecycle SET verification='verified',review_after=NULL,source_json=? WHERE id=?")
              .run(JSON.stringify({ ...source, ...(revision ? { revision } : {}) }), row.id);
          } else this.db!.query("UPDATE memory_lifecycle SET verification=?,review_after=? WHERE id=?").run(request.state, now, row.id);
          this.db!.query("UPDATE memories SET version=version+1,updated_at=? WHERE id=?").run(now, row.id);
        }
      }
      const response: MemoryResponse = { status: "ok", retired };
      this.storeReceipt(request.operationId, hash, response, now);
      return response;
    }).immediate() as MemoryResponse;
  }

  private checkpoint(request: Extract<MemoryRequest, { op: "checkpoint" }>, authority: MemoryAuthority): MemoryResponse {
    if (!validId(request.operationId) || !validText(request.threadId) || !validOptionalText(request.projectKey) ||
      !validStringList(request.decided) || !validStringList(request.open) || !validStringList(request.next) ||
      !Array.isArray(request.pointers) || request.pointers.length > 20 || request.pointers.some(validateSource)) return invalid("MEMORY_REQUEST_INVALID");
    const structured: MemoryCheckpoint = { decided: request.decided, open: request.open, next: request.next, pointers: request.pointers };
    if (Buffer.byteLength(JSON.stringify(structured), "utf8") > MAX_CONTENT_BYTES) return invalid("MEMORY_REQUEST_INVALID");
    const stableId = checkpointId(request.threadId, request.projectKey);
    const saveRequest: Extract<MemoryRequest, { op: "save" }> = {
      op: "save", operationId: request.operationId,
      content: JSON.stringify(structured), scope: "conversation", kind: "context", provenance: "checkpoint",
      source: { type: "run", ref: request.threadId }, conversationId: request.threadId,
      ...(request.projectKey ? { projectKey: request.projectKey } : {}),
    };
    const normalized = validateSave(saveRequest, this.workspace);
    if (typeof normalized === "string") return invalid(normalized);
    const hash = requestHash(request);
    const result = this.db!.transaction(() => {
      const receipt = this.receipt(request.operationId, hash); if (receipt) return receipt;
      const now = new Date().toISOString();
      const stable = this.row(stableId);
      const targetId = stableId;
      const budget = stable ? null : this.checkBudget(normalized, normalized.content, undefined, "approved");
      let response: MemoryResponse;
      if (stable) response = { status: "conflict", error: "MEMORY_THREAD_CLOSED", memory: publicRecord(stable) };
      else if (budget) response = budget;
      else {
        this.db!.query(`INSERT INTO memories
          (id,version,content,scope,kind,provenance,project_key,mission_id,expires_at,reusable,explicit,created_at,updated_at)
          VALUES(?,1,?,?,?,?,?,?,?,?,1,?,?)`)
          .run(targetId, normalized.content, normalized.baseScope, normalized.kind, normalized.provenance,
            normalized.projectKey, normalized.missionId, normalized.expiresAt, 0, now, now);
        this.upsertLifecycle(targetId, normalized, "approved", structured);
        response = { status: "ok", memory: publicRecord(this.row(targetId)!) };
      }
      this.storeReceipt(request.operationId, hash, response, now);
      return response;
    }).immediate() as MemoryResponse;
    if (result.status === "ok" && "memory" in result && result.memory) this.refreshDerivatives(result.memory.id);
    return result;
  }

  private brief(threadId: string, projectKey?: string): MemoryResponse {
    if (!validText(threadId) || !validOptionalText(projectKey)) return invalid("MEMORY_REQUEST_INVALID");
    const row = this.db!.query(`${SELECT_STORED} WHERE COALESCE(l.scope,m.scope)='conversation'
      AND l.conversation_id=? AND (m.project_key IS NULL OR m.project_key=?)
      AND COALESCE(l.status,'active')='active' AND COALESCE(l.approval,'approved')='approved'
      AND (l.verification IS NULL OR l.verification='verified')
      AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY m.updated_at DESC,m.id DESC LIMIT 1`)
      .get(threadId, projectKey ?? null, new Date().toISOString()) as Stored | null;
    if (!row) return { status: "ok" };
    const checkpoint = parseJson<MemoryCheckpoint>(row.structured_json) ?? parseJson<MemoryCheckpoint>(row.content);
    return checkpoint ? { status: "ok", checkpoint, pointers: checkpoint.pointers, memory: publicRecord(row) } : { status: "ok" };
  }

  private inspect(cursor?: string, requestedLimit?: number, missionsOnly?: boolean, authority: MemoryAuthority = "agent"): MemoryResponse {
    if ((cursor !== undefined && !validId(cursor)) ||
      (requestedLimit !== undefined && (!Number.isInteger(requestedLimit) || requestedLimit < 1))) return invalid("MEMORY_REQUEST_INVALID");
    const limit = Math.min(requestedLimit ?? MAX_INSPECT_RESULTS, MAX_INSPECT_RESULTS);
    if (authority === "agent") return forbidden();
    const predicate = missionsOnly
      ? `m.id>? AND COALESCE(l.status,'active')='active' AND (l.mission_json IS NOT NULL OR COALESCE(l.scope,m.scope)='mission')`
      : "m.id>?";
    const rows = this.db!.query(`${SELECT_STORED} WHERE ${predicate} ORDER BY m.id LIMIT ?`).all(cursor ?? "", limit + 1) as Stored[];
    const candidates = rows.map(publicRecord);
    if (!missionsOnly) {
      const legacy = this.searchLegacy("", false);
      if (legacy && legacy.id > (cursor ?? "")) candidates.push(legacy);
    }
    candidates.sort((left, right) => left.id.localeCompare(right.id));
    const page = boundedRecords(candidates.slice(0, limit));
    return { status: "ok", memories: page, ...(candidates.length > page.length ? { nextCursor: page.at(-1)!.id } : {}) };
  }

  private maintain(): MemoryResponse {
    const now = new Date().toISOString();
    const expiredRows = this.db!.query(`${SELECT_STORED} WHERE (COALESCE(l.status,'active')='active')
      AND m.expires_at IS NOT NULL AND m.expires_at<=? LIMIT 100`).all(now) as Stored[];
    this.db!.transaction(() => {
      for (const row of expiredRows) {
        this.ensureLifecycle(row);
        this.db!.query("UPDATE memory_lifecycle SET status='retired' WHERE id=?").run(row.id);
        this.db!.query("UPDATE memories SET version=version+1,updated_at=? WHERE id=?").run(now, row.id);
      }
    }).immediate();
    this.groomRepositorySources();
    let indexMore = false;
    try { this.ensureIndex(); indexMore = this.maintainIndexBatch(); } catch { try { this.markIndexDirty(); } catch {} }
    this.writeSnapshots();
    this.searchLegacy("", false);
    const moreExpired = expiredRows.length === 100;
    return moreExpired || indexMore ? { status: "ok", more: true, ...(expiredRows.length ? { retired: expiredRows.length } : {}) }
      : { status: "ok", ...(expiredRows.length ? { retired: expiredRows.length } : {}) };
  }

  private groomRepositorySources(): void {
    const cursor = (this.db!.query("SELECT value FROM memory_meta WHERE key='repository_groom_cursor'").get() as { value: string } | null)?.value ?? "";
    const rows = (this.db!.query(`${SELECT_STORED} WHERE m.id>? AND COALESCE(l.status,'active')='active'
      AND COALESCE(l.approval,'approved')='approved' AND json_extract(l.source_json,'$.type')='repository'
      ORDER BY m.id LIMIT ?`).all(cursor, REPOSITORY_GROOM_RECORDS) as Stored[]);
    let bytes = 0;
    let lastProcessed = cursor;
    for (const row of rows.slice(0, REPOSITORY_GROOM_RECORDS)) {
      const source = effectiveSource(row);
      const checked = repositoryRevision(this.workspace, source.ref, REPOSITORY_GROOM_BYTES - bytes);
      if (checked.overBudget && bytes > 0) break;
      lastProcessed = row.id;
      bytes += checked.bytes;
      const verification = !checked.revision ? "missing" : checked.revision === source.revision ? "verified" : "changed";
      const reviewAfter = verification === "verified" ? null : row.review_after ?? new Date().toISOString();
      if (row.verification !== verification || row.review_after !== reviewAfter) {
        this.db!.transaction(() => {
          if (this.row(row.id)?.version !== row.version) return;
          this.db!.query("UPDATE memory_lifecycle SET verification=?,review_after=? WHERE id=?").run(verification, reviewAfter, row.id);
          this.db!.query("UPDATE memories SET version=version+1,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
        }).immediate();
      }
      if (bytes >= REPOSITORY_GROOM_BYTES) break;
    }
    const next = rows.length && (rows.length === REPOSITORY_GROOM_RECORDS || lastProcessed !== rows.at(-1)?.id) ? lastProcessed : "";
    this.db!.query(`INSERT INTO memory_meta(key,value) VALUES('repository_groom_cursor',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(next);
  }

  private checkBudget(value: NormalizedSave, content: string, replacingId?: string,
    approval: MemoryApproval = "approved"): MemoryResponse | null {
    const rows = this.db!.query(SELECT_STORED).all() as Stored[];
    const retained = rows.filter(row => row.id !== replacingId);
    const replacedTargets = approval === "approved" ? new Set(value.supersedes.map(item => item.id)) : new Set<string>();
    const active = retained.filter(row => effectiveStatus(row) === "active" && !replacedTargets.has(row.id) &&
      scopeKey(row) === normalizedScopeKey(value));
    const limits = limitsFor(rows);
    const contentBytes = Buffer.byteLength(content, "utf8");
    const retainedBytes = retained.reduce((sum, row) => sum + Buffer.byteLength(row.content, "utf8"), 0);
    if (retained.length + 1 > RETAINED_RECORD_LIMIT || retainedBytes + contentBytes > RETAINED_BYTE_LIMIT ||
      active.length + 1 > SCOPE_RECORD_LIMIT ||
      active.reduce((sum, row) => sum + Buffer.byteLength(row.content, "utf8"), 0) + contentBytes > SCOPE_BYTE_LIMIT)
      return { status: "consolidation_required", error: "MEMORY_BUDGET_EXCEEDED", limits };
    return null;
  }

  private completed(value: NormalizedSave): boolean {
    const refs: Array<[string, string]> = [];
    if (!value.mission) refs.push([value.source.type, normalizedSource(value.source).ref]);
    else if (value.mission.stopCondition === "pr_merged" && value.mission.pr)
      refs.push(["pr", normalizedSource({ type: "pr", ref: value.mission.pr }).ref]);
    else if (value.mission.stopCondition === "work_completed") {
      refs.push(["ticket", normalizedSource({ type: "ticket", ref: value.mission.ticket }).ref]);
      refs.push(["run", value.mission.ticket]);
    }
    return refs.some(([type, ref]) => !!this.db!.query("SELECT 1 FROM memory_completion_tombstones WHERE source_type=? AND source_ref=?")
      .get(type, ref));
  }

  private mutation(request: { operationId: string }, action: () => MemoryResponse, refreshId?: string): MemoryResponse {
    const hash = requestHash(request as MemoryRequest);
    const result = this.db!.transaction(() => {
      const receipt = this.receipt(request.operationId, hash); if (receipt) return receipt;
      const response = action(); this.storeReceipt(request.operationId, hash, response, new Date().toISOString()); return response;
    }).immediate() as MemoryResponse;
    if (result.status === "ok" && refreshId) this.refreshDerivatives(refreshId);
    return result;
  }

  private row(id: string): Stored | null { return this.db!.query(`${SELECT_STORED} WHERE m.id=?`).get(id) as Stored | null; }
  private lifecycle(id: string): any { return this.db!.query("SELECT * FROM memory_lifecycle WHERE id=?").get(id); }
  private ensureLifecycle(row: Stored): void {
    if (row.status) return;
    this.db!.query(`INSERT INTO memory_lifecycle
      (id,scope,status,approval,asserted_at,source_json,supersedes_json,superseded_by_json,uncertain)
      VALUES(?,?,'active','approved',?,?,'[]','[]',0) ON CONFLICT DO NOTHING`)
      .run(row.id, row.base_scope, row.created_at, JSON.stringify({ type: "run", ref: `legacy:${row.provenance}` }));
  }
  private receipt(operationId: string, hash: string): MemoryResponse | null {
    if (this.db!.query("SELECT 1 FROM memory_meta WHERE key=?").get(`legacy-intent:${operationId}`))
      return { status: "conflict", error: "MEMORY_OPERATION_CONFLICT" };
    const row = this.db!.query("SELECT request_hash,response_json FROM memory_mutations WHERE operation_id=?").get(operationId) as any;
    if (!row) return null;
    return row.request_hash === hash ? JSON.parse(row.response_json) : { status: "conflict", error: "MEMORY_OPERATION_CONFLICT" };
  }
  private storeReceipt(operationId: string, hash: string, response: MemoryResponse, now: string): void {
    this.db!.query("INSERT INTO memory_mutations(operation_id,request_hash,response_json,created_at) VALUES(?,?,?,?)")
      .run(operationId, hash, JSON.stringify(response), now);
  }

  private ensureIndex(): void {
    this.db!.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,content,tokenize='unicode61')");
    if (this.db!.query("SELECT 1 FROM memory_meta WHERE key='fts_cursor'").get()) return;
    const count = (this.db!.query("SELECT count(*) AS count FROM memory_fts").get() as any).count;
    const records = (this.db!.query("SELECT count(*) AS count FROM memories").get() as any).count;
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
    const dirty = this.db!.query("SELECT id FROM memory_index_dirty ORDER BY id LIMIT 100").all() as Array<{ id: string }>;
    if (dirty.length) this.db!.transaction(() => {
      for (const entry of dirty) {
        this.db!.query("DELETE FROM memory_fts WHERE id=?").run(entry.id);
        const row = this.row(entry.id); if (row) this.db!.query("INSERT INTO memory_fts(id,content) VALUES(?,?)").run(row.id, row.content);
        this.db!.query("DELETE FROM memory_index_dirty WHERE id=?").run(entry.id);
      }
    }).immediate();
    if (dirty.length === 100) return true;
    const meta = this.db!.query("SELECT value FROM memory_meta WHERE key='fts_cursor'").get() as { value: string } | null;
    if (!meta) return false;
    const batchSize = 100 - dirty.length;
    const rows = this.db!.query("SELECT id,content FROM memories WHERE id>? ORDER BY id LIMIT ?").all(meta.value, batchSize) as any[];
    this.db!.transaction(() => {
      for (const row of rows) { this.db!.query("DELETE FROM memory_fts WHERE id=?").run(row.id); this.db!.query("INSERT INTO memory_fts(id,content) VALUES(?,?)").run(row.id, row.content); }
      if (rows.length < batchSize) this.db!.query("DELETE FROM memory_meta WHERE key='fts_cursor'").run();
      else this.db!.query("UPDATE memory_meta SET value=? WHERE key='fts_cursor'").run(rows.at(-1)!.id);
    }).immediate();
    return rows.length === batchSize;
  }
  private indexDirty(): boolean { return !!this.db!.query("SELECT 1 FROM memory_meta WHERE key='fts_cursor' UNION ALL SELECT 1 FROM memory_index_dirty LIMIT 1").get(); }
  private markIndexDirty(): void { this.db!.query("INSERT INTO memory_meta(key,value) VALUES('fts_cursor','') ON CONFLICT(key) DO NOTHING").run(); }
  private refreshDerivatives(id: string): void {
    try { this.db!.transaction(() => {
      this.db!.query("DELETE FROM memory_fts WHERE id=?").run(id); const row = this.row(id);
      if (row) this.db!.query("INSERT INTO memory_fts(id,content) VALUES(?,?)").run(id, row.content);
      this.db!.query("DELETE FROM memory_index_dirty WHERE id=?").run(id);
    }).immediate(); } catch { try { this.beginIndexRebuild(); } catch { try { this.markIndexDirty(); } catch {} } }
    this.writeSnapshots();
  }
  private writeSnapshots(): void {
    const now = new Date().toISOString();
    const lifecycleVisibility = `COALESCE(l.status,'active')='active' AND COALESCE(l.approval,'approved')='approved'
      AND (l.verification IS NULL OR l.verification='verified') AND (m.expires_at IS NULL OR m.expires_at>?)`;
    const startup = (this.db!.query(`${SELECT_STORED} WHERE ${lifecycleVisibility} AND m.explicit=1
      AND COALESCE(l.scope,m.scope) IN ('user','companion','global') AND m.kind IN ('preference','correction')
      ORDER BY m.updated_at DESC,m.id LIMIT 100`).all(now) as Stored[]).map(snapshotRecord);
    const reusable = (this.db!.query(`${SELECT_STORED} WHERE ${lifecycleVisibility} AND m.reusable=1
      ORDER BY m.updated_at DESC,m.id LIMIT 200`).all(now) as Stored[]).map(templateRecord);
    try { atomicBoundedJson(this.memoryDir, this.startupPath, "memories", startup, MAX_STARTUP_BYTES); } catch {}
    try { atomicBoundedJson(this.workspace, this.templatePath, "memories", reusable, MAX_TEMPLATE_BYTES, { version: 1 }); } catch {}
  }
  private importTemplateOnce(): void {
    if (this.db!.query("SELECT value FROM memory_meta WHERE key='template_imported'").get()) return;
    const mark = () => this.db!.query("INSERT INTO memory_meta(key,value) VALUES('template_imported','1') ON CONFLICT DO NOTHING").run();
    if ((this.db!.query("SELECT count(*) AS count FROM memories").get() as any).count) { mark(); return; }
    let document: any;
    try { safeRegularOrMissing(this.templatePath); if (lstatSync(this.templatePath).size > MAX_TEMPLATE_BYTES) throw 0; document = JSON.parse(readFileSync(this.templatePath, "utf8")); }
    catch { mark(); return; }
    const candidates = document?.version === 1 && Array.isArray(document.memories) ? document.memories.slice(0, 100) : [];
    for (const [index, candidate] of candidates.entries()) {
      if (!candidate || typeof candidate !== "object" || !candidate.reusable || candidate.scope === "user" || candidate.kind === "context" ||
        (candidate.status !== undefined && candidate.status !== "active") ||
        (candidate.approval !== undefined && candidate.approval !== "approved") ||
        candidate.verification === "changed" || candidate.verification === "missing") continue;
      this.save({ op: "save", operationId: `import-${index}`, content: candidate.content, scope: candidate.scope, kind: candidate.kind,
        provenance: candidate.provenance, source: candidate.source, projectKey: candidate.projectKey,
        expiresAt: candidate.expiresAt, reusable: true }, "human");
    }
    mark();
  }

  private searchLegacy(query: string, truncate: boolean): MemoryRecord | null {
    const path = join(this.workspace, "MEMORY.md");
    try {
      safeRegularOrMissing(path); const info = lstatSync(path); if (info.size > MAX_LEGACY_BYTES) return null;
      const bytes = readFileSync(path); const content = bytes.toString("utf8"); const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      let matches = terms.every(term => content.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
      const digest = createHash("sha256").update(bytes).digest("hex");
      try {
        this.db!.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_legacy_fts USING fts5(content,tokenize='unicode61')");
        const indexed = this.db!.query("SELECT value FROM memory_meta WHERE key='legacy_digest'").get() as any;
        const present = this.db!.query("SELECT 1 FROM memory_legacy_fts LIMIT 1").get();
        if (indexed?.value !== digest || !present) this.db!.transaction(() => {
          this.db!.exec("DELETE FROM memory_legacy_fts"); this.db!.query("INSERT INTO memory_legacy_fts(content) VALUES(?)").run(content);
          this.db!.query("INSERT INTO memory_meta(key,value) VALUES('legacy_digest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(digest);
        }).immediate();
        if (terms.length) matches = !!this.db!.query("SELECT 1 FROM memory_legacy_fts WHERE memory_legacy_fts MATCH ? LIMIT 1")
          .get(terms.map(term => `"${term}"`).join(" AND "));
      } catch { try { this.db!.exec("DROP TABLE IF EXISTS memory_legacy_fts; DELETE FROM memory_meta WHERE key='legacy_digest'"); } catch {} }
      if (!matches) return null;
      const lifecycle = this.lifecycle("legacy-shared-memory");
      const timestamp = new Date(info.mtimeMs).toISOString();
      return { id: "legacy-shared-memory", version: lifecycle?.version ?? 1, content: truncate ? snippet(content, query) : content,
        scope: lifecycle?.scope ?? "companion", kind: "fact", provenance: "legacy MEMORY.md",
        source: lifecycle ? parseJson(lifecycle.source_json)! : { type: "run", ref: "legacy:workspace/MEMORY.md" },
        status: lifecycle?.status ?? "active", approval: lifecycle?.approval ?? "approved",
        assertedAt: lifecycle?.asserted_at ?? timestamp, createdAt: timestamp, updatedAt: timestamp,
        supersedes: [], supersededBy: [], reusable: false };
    } catch { return null; }
  }
}

const SELECT_STORED = `SELECT m.id,m.version,m.content,m.scope AS base_scope,m.kind,m.provenance,m.project_key,
  m.mission_id,m.expires_at,m.reusable,m.created_at,m.updated_at,m.explicit,l.scope AS lifecycle_scope,
  l.status,l.approval,l.asserted_at,l.review_after,l.source_json,l.mission_json,l.conversation_id,
  l.supersedes_json,l.superseded_by_json,l.uncertain,l.verification,l.structured_json
  FROM memories m LEFT JOIN memory_lifecycle l ON l.id=m.id`;
const VISIBLE_SQL = `COALESCE(l.status,'active')='active' AND COALESCE(l.approval,'approved')='approved'
  AND (l.verification IS NULL OR l.verification='verified') AND (m.expires_at IS NULL OR m.expires_at>?)
  AND (COALESCE(l.scope,m.scope)!='project' OR m.project_key=?)
  AND (COALESCE(l.scope,m.scope)!='mission' OR (m.mission_id=? AND (? IS NULL OR m.project_key=?)))
  AND (COALESCE(l.scope,m.scope)!='conversation' OR (l.conversation_id=? AND (m.project_key IS NULL OR m.project_key=?)))
  AND (m.kind!='context' OR COALESCE(l.scope,m.scope)='conversation' OR m.mission_id=?)`;

function validateSave(request: Extract<MemoryRequest, { op: "save" }>, workspace: string): string | NormalizedSave {
  if (!validId(request.operationId) || (request.id !== undefined && !validId(request.id)) ||
    (request.expectedVersion !== undefined && (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1)) ||
    !validText(request.content) || Buffer.byteLength(request.content, "utf8") > MAX_CONTENT_BYTES ||
    !["user", "companion", "project", "global", "mission", "conversation"].includes(request.scope) ||
    !["fact", "preference", "correction", "procedure", "context"].includes(request.kind) ||
    !validText(request.provenance) || request.provenance.length > 1_000 || !validOptionalText(request.projectKey) ||
    !validOptionalText(request.missionId) || !validOptionalText(request.conversationId) ||
    (request.source && validateSource(request.source)) || (request.supersedes && (!Array.isArray(request.supersedes) || request.supersedes.length > 20 ||
      request.supersedes.some(item => !validId(item.id) || !Number.isInteger(item.expectedVersion) || item.expectedVersion < 1)))) return "MEMORY_REQUEST_INVALID";
  if (request.id === undefined && request.expectedVersion !== undefined) return "MEMORY_REQUEST_INVALID";
  if (request.scope === "project" ? !validText(request.projectKey) :
    request.scope !== "mission" && request.scope !== "conversation" && request.projectKey !== undefined) return "MEMORY_SCOPE_INVALID";
  if (request.scope === "mission") {
    if (!validText(request.missionId) || !validateMission(request.mission)) return "MEMORY_SCOPE_INVALID";
  } else if (request.scope === "conversation") {
    if (!validText(request.conversationId)) return "MEMORY_SCOPE_INVALID";
  } else if (request.kind === "context" ? !validText(request.missionId) && !validText(request.conversationId) : request.missionId !== undefined || request.conversationId !== undefined)
    return "MEMORY_CONTEXT_INVALID";
  let expiresAt = normalizeDate(request.expiresAt); if (expiresAt === false) return "MEMORY_EXPIRY_INVALID";
  const reviewAfter = normalizeDate(request.reviewAfter); if (reviewAfter === false) return "MEMORY_EXPIRY_INVALID";
  const assertedAt = normalizeDate(request.assertedAt ?? new Date().toISOString()); if (assertedAt === false || assertedAt === null) return "MEMORY_EXPIRY_INVALID";
  if ((request.kind === "context" || request.scope === "mission") && expiresAt === null)
    expiresAt = new Date(Date.now() + CONTEXT_TTL_MS).toISOString();
  const reusable = request.reusable ?? false;
  if (reusable && !((request.scope === "project" && ["fact", "procedure"].includes(request.kind)) ||
    (request.scope === "companion" && request.kind === "procedure"))) return "MEMORY_REUSABLE_INVALID";
  let source = normalizedSource(request.source ?? { type: "run" as const, ref: `legacy:${request.provenance}` });
  let content = request.content;
  if (source.type === "repository") {
    const revision = repositoryRevision(workspace, source.ref, REPOSITORY_GROOM_BYTES).revision;
    source = { ...source, ...(revision ? { revision } : {}) };
    content = `See ${source.ref}`;
  }
  const baseScope = request.scope === "mission" ? "project" : request.scope === "conversation" || request.scope === "global" ? "companion" : request.scope;
  return { content, scope: request.scope, baseScope, kind: request.kind, provenance: request.provenance, source,
    projectKey: request.scope === "mission" ? request.mission!.workspace : request.projectKey ?? null,
    missionId: request.missionId ?? null, mission: request.mission ? { ...request.mission,
      ...(request.mission.pr ? { pr: normalizedSource({ type: "pr", ref: request.mission.pr }).ref } : {}) } : null,
    conversationId: request.conversationId ?? null,
    assertedAt, reviewAfter, expiresAt, reusable, uncertain: request.uncertain ?? false, supersedes: request.supersedes ?? [] };
}

function publicRecord(row: Stored): MemoryRecord {
  return { id: row.id, version: row.version, content: row.content, scope: effectiveScope(row), kind: row.kind,
    provenance: row.provenance, source: effectiveSource(row), status: effectiveStatus(row), approval: effectiveApproval(row),
    assertedAt: row.asserted_at ?? row.created_at, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.review_after ? { reviewAfter: row.review_after } : {}), ...(row.project_key ? { projectKey: row.project_key } : {}),
    ...(row.mission_id ? { missionId: row.mission_id } : {}), ...(row.mission_json ? { mission: parseJson<MemoryMission>(row.mission_json)! } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}), ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    supersedes: parseSupersedes(row).map(item => item.id), supersededBy: parseSupersededBy(row), reusable: !!row.reusable,
    ...(row.uncertain ? { uncertain: true } : {}), ...(row.verification ? { verification: row.verification } : {}),
    ...(row.structured_json ? { structured: parseJson<MemoryCheckpoint>(row.structured_json)! } : {}) };
}

function normalizedFromRow(row: Stored): NormalizedSave {
  return { content: row.content, scope: effectiveScope(row), baseScope: row.base_scope, kind: row.kind,
    provenance: row.provenance, source: effectiveSource(row), projectKey: row.project_key, missionId: row.mission_id,
    mission: parseJson(row.mission_json), conversationId: row.conversation_id, assertedAt: row.asserted_at ?? row.created_at,
    reviewAfter: row.review_after, expiresAt: row.expires_at, reusable: !!row.reusable, uncertain: !!row.uncertain,
    supersedes: parseSupersedes(row) };
}
function preserveOmittedLifecycle(value: NormalizedSave, row: Stored,
  request: Extract<MemoryRequest, { op: "save" }>): NormalizedSave {
  const source = request.source === undefined ? effectiveSource(row) : value.source;
  return { ...value,
    content: source.type === "repository" ? `See ${source.ref}` : value.content,
    source,
    assertedAt: request.assertedAt === undefined ? row.asserted_at ?? row.created_at : value.assertedAt,
    reviewAfter: request.reviewAfter === undefined ? row.review_after : value.reviewAfter,
    expiresAt: request.expiresAt === undefined ? row.expires_at : value.expiresAt,
    mission: request.mission === undefined ? parseJson<MemoryMission>(row.mission_json) : value.mission,
    conversationId: request.conversationId === undefined ? row.conversation_id : value.conversationId,
    uncertain: request.uncertain === undefined ? !!row.uncertain : value.uncertain,
    supersedes: request.supersedes === undefined ? parseSupersedes(row) : value.supersedes,
  };
}
function effectiveScope(row: Stored): MemoryScope { return row.lifecycle_scope ?? row.base_scope; }
function effectiveStatus(row: Stored): MemoryStatus { return row.status ?? "active"; }
function effectiveApproval(row: Stored): MemoryApproval { return row.approval ?? "approved"; }
function effectiveSource(row: Stored): MemorySource { return parseJson<MemorySource>(row.source_json) ?? { type: "run", ref: `legacy:${row.provenance}` }; }
function parseSupersedes(row: Stored): Array<{ id: string; expectedVersion: number }> { return parseJson(row.supersedes_json) ?? []; }
function parseSupersededBy(row: Stored): string[] { return parseJson(row.superseded_by_json) ?? []; }
function sameIdentity(row: Stored, value: NormalizedSave): boolean { return scopeKey(row) === normalizedScopeKey(value); }
function scopeKey(row: Stored): string { return `${effectiveScope(row)}:${row.project_key ?? ""}:${row.mission_id ?? ""}:${row.conversation_id ?? ""}`; }
function normalizedScopeKey(value: NormalizedSave): string { return `${value.scope}:${value.projectKey ?? ""}:${value.missionId ?? ""}:${value.conversationId ?? ""}`; }
function visible(row: Stored, projectKey?: string, missionId?: string, conversationId?: string): boolean {
  if (effectiveStatus(row) !== "active" || effectiveApproval(row) !== "approved" || row.verification === "changed" || row.verification === "missing" || expired(row)) return false;
  const scope = effectiveScope(row);
  if (scope === "project" && row.project_key !== projectKey) return false;
  if (scope === "mission" && (row.mission_id !== missionId || (projectKey !== undefined && row.project_key !== projectKey))) return false;
  if (scope === "conversation" && (row.conversation_id !== conversationId ||
    (row.project_key !== null && row.project_key !== projectKey))) return false;
  if (row.kind === "context" && scope !== "conversation" && row.mission_id !== missionId) return false;
  return true;
}
function visibleRecord(record: MemoryRecord, projectKey?: string, missionId?: string, conversationId?: string): boolean {
  if (record.status !== "active" || record.approval !== "approved" || record.verification === "changed" || record.verification === "missing" ||
    (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())) return false;
  if (record.scope === "project" && record.projectKey !== projectKey) return false;
  if (record.scope === "mission" && record.missionId !== missionId) return false;
  if (record.scope === "conversation" && (record.conversationId !== conversationId ||
    (record.projectKey !== undefined && record.projectKey !== projectKey))) return false;
  return true;
}
function sourceMatches(row: Stored, source: Pick<MemorySource, "type" | "ref">, state: string): boolean {
  const direct = normalizedSource(effectiveSource(row));
  const mission = parseJson<MemoryMission>(row.mission_json);
  if (state !== "completed" && state !== "merged") return direct.type === source.type && direct.ref === source.ref;
  if (!mission) return direct.type === source.type && direct.ref === source.ref;
  if (mission.stopCondition === "pr_merged")
    return state === "merged" && source.type === "pr" && mission.pr === source.ref;
  if (state !== "completed") return false;
  if (source.type === "ticket")
    return normalizedSource({ type: "ticket", ref: mission.ticket }).ref === source.ref;
  return source.type === "run" && mission.ticket === source.ref;
}
function approvalFor(authority: MemoryAuthority, value: NormalizedSave): MemoryApproval {
  return authority === "human" || (!value.uncertain &&
    (value.kind === "context" || (value.scope === "project" && value.kind === "fact"))) ? "approved" : "pending";
}
function checkpointId(threadId: string, projectKey?: string): string {
  return `checkpoint:${createHash("sha256").update(`${threadId}\0${projectKey ?? ""}`).digest("hex").slice(0, 32)}`;
}
function validateMission(value: unknown): value is MemoryMission {
  const mission = value as MemoryMission | undefined;
  return !!mission && validText(mission.ticket) && validText(mission.workspace) && validOptionalText(mission.pr) &&
    ["pr_merged", "work_completed"].includes(mission.stopCondition) &&
    (mission.stopCondition !== "pr_merged" || validText(mission.pr));
}
function validateSource(value: MemorySource): boolean {
  return !value || !["run", "ticket", "pr", "repository"].includes(value.type) || !validText(value.ref) ||
    !validOptionalText(value.revision) || value.ref.length > 1_000 || (value.revision?.length ?? 0) > 200;
}
function normalizedSource<T extends Pick<MemorySource, "type" | "ref"> & { revision?: string }>(source: T): T {
  const trimmed = source.ref.replace(/\/+$/, "");
  if (source.type === "pr") {
    const match = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/i);
    return match ? { ...source, ref: `https://github.com/${match[1]!.toLocaleLowerCase()}/${match[2]!.toLocaleLowerCase()}/pull/${match[3]}` } : { ...source, ref: trimmed };
  }
  if (source.type === "ticket") {
    const github = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/i);
    if (github) return { ...source, ref: `https://github.com/${github[1]!.toLocaleLowerCase()}/${github[2]!.toLocaleLowerCase()}/issues/${github[3]}` };
    if (/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(trimmed)) return { ...source, ref: trimmed.toLocaleUpperCase() };
    return { ...source, ref: trimmed };
  }
  return source;
}
function repositoryRevision(workspace: string, ref: string, budget: number): { revision?: string; bytes: number; overBudget?: true } {
  try {
    const path = isAbsolute(ref) ? resolve(ref) : resolve(workspace, ref.replace(/^workspace\//, ""));
    const outside = relative(workspace, path); if (outside.startsWith("..") || isAbsolute(outside)) return { bytes: 0 };
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) return { bytes: 0 };
      if (info.size > Math.max(0, budget)) return { bytes: 0, overBudget: true };
      const bytes = Buffer.alloc(Math.max(0, budget));
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      if (count !== info.size || fstatSync(fd).size !== count) return { bytes: count, overBudget: true };
      return { revision: createHash("sha256").update(bytes.subarray(0, count)).digest("hex"), bytes: count };
    } finally { closeSync(fd); }
  } catch { return { bytes: 0 }; }
}
function limitsFor(rows: Stored[]): MemoryLimits { return { scopeRecords: SCOPE_RECORD_LIMIT, scopeBytes: SCOPE_BYTE_LIMIT,
  retainedRecords: RETAINED_RECORD_LIMIT, retainedBytes: RETAINED_BYTE_LIMIT }; }
function snapshotRecord(row: Stored) { const record = publicRecord(row); return { id: record.id, version: record.version, scope: record.scope, kind: record.kind,
  content: record.content, provenance: record.provenance, source: record.source, assertedAt: record.assertedAt,
  status: record.status, approval: record.approval, ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}) }; }
function templateRecord(row: Stored) { const record = publicRecord(row); return { content: record.content, scope: record.scope, kind: record.kind,
  provenance: record.provenance, source: record.source, ...(record.projectKey ? { projectKey: record.projectKey } : {}),
  ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}), reusable: true }; }
function updatedDesc(a: Stored, b: Stored): number { return b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id); }
function expired(row: Stored): boolean { return row.expires_at !== null && Date.parse(row.expires_at) <= Date.now(); }
function normalizeDate(value?: string): string | null | false { if (value === undefined) return null; if (!validText(value) || !Number.isFinite(Date.parse(value))) return false; return new Date(value).toISOString(); }
function validStringList(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 50 && value.every(item => validText(item) && Buffer.byteLength(item, "utf8") <= 1_000); }
function validOptionalText(value: unknown): value is string | undefined { return value === undefined || validText(value); }
function validText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 10_000; }
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function validMutationTarget(request: any): boolean { return validId(request.operationId) && validId(request.id) && Number.isInteger(request.expectedVersion) && request.expectedVersion >= 1; }
function invalid(error: string): MemoryResponse { return { status: "invalid", error }; }
function forbidden(): MemoryResponse { return { status: "forbidden", error: "MEMORY_AUTHORITY_REQUIRED" }; }
function unavailable(): MemoryResponse { return { status: "unavailable", error: "MEMORY_UNAVAILABLE" }; }
function requestHash(request: MemoryRequest): string { return createHash("sha256").update(JSON.stringify(canonical(request))).digest("hex"); }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
  .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])); return value; }
function parseJson<T>(value: string | null): T | null { if (!value) return null; try { return JSON.parse(value) as T; } catch { return null; } }
function snippet(content: string, query: string): string { if (content.length <= MAX_SNIPPET_CHARS) return content; const term = query.match(/[\p{L}\p{N}_]+/u)?.[0]?.toLocaleLowerCase();
  const found = term ? content.toLocaleLowerCase().indexOf(term) : 0; const start = Math.max(0, Math.min(content.length - MAX_SNIPPET_CHARS, found - 200)); return content.slice(start, start + MAX_SNIPPET_CHARS); }
function safeDirectory(path: string): void { try { const info = lstatSync(path); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("MEMORY_PATH_UNSAFE"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; mkdirSync(path, { recursive: true, mode: 0o700 }); const info = lstatSync(path); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("MEMORY_PATH_UNSAFE"); } }
function safeRegularOrMissing(path: string): void { try { const info = lstatSync(path); if (info.isSymbolicLink() || !info.isFile()) throw new Error("MEMORY_PATH_UNSAFE"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
function atomicBoundedJson(directory: string, path: string, key: string, items: unknown[], limit: number, prefix: Record<string, unknown> = {}): void {
  safeDirectory(directory); safeRegularOrMissing(path); const accepted: unknown[] = [];
  for (const item of items) { if (Buffer.byteLength(JSON.stringify({ ...prefix, [key]: [...accepted, item] }), "utf8") <= limit) accepted.push(item); }
  const temporary = join(directory, `.memory-${randomUUID()}.tmp`);
  try { writeFileSync(temporary, JSON.stringify({ ...prefix, [key]: accepted }), { flag: "wx", mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

/** Leave room for the response envelope; a single escaped legacy file may exceed the list budget. */
function boundedRecords(records: MemoryRecord[]): MemoryRecord[] {
  const page: MemoryRecord[] = [];
  let bytes = 512;
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (page.length && bytes + size > MAX_LIST_BYTES) break;
    page.push(record);
    bytes += size;
  }
  return page;
}
