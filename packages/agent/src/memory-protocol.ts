/** Includes worst-case JSON escaping of the preserved 30,000-byte legacy file. */
export const MEMORY_TRANSPORT_MAX_BYTES = 256 * 1024;

export async function readMemoryJson(input: { body: ReadableStream<Uint8Array> | null }): Promise<any> {
  const reader = input.body?.getReader();
  if (!reader) throw new Error("MEMORY_REQUEST_INVALID");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MEMORY_TRANSPORT_MAX_BYTES) { await reader.cancel(); throw new Error("MEMORY_TOO_LARGE"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export type MemoryScope = "user" | "companion" | "project" | "global" | "mission" | "conversation";
export type MemoryKind = "fact" | "preference" | "correction" | "procedure" | "context";
export type MemoryStatus = "active" | "superseded" | "retired";
export type MemoryApproval = "approved" | "pending";
export type MemoryAuthority = "agent" | "human" | "system";

export interface MemorySource {
  type: "run" | "ticket" | "pr" | "repository";
  ref: string;
  revision?: string;
}

export interface MemoryMission {
  ticket: string;
  workspace: string;
  pr?: string;
  stopCondition: "pr_merged" | "work_completed";
}

export interface MemoryCheckpoint {
  decided: string[];
  open: string[];
  next: string[];
  pointers: MemorySource[];
}

export interface MemoryRecord {
  id: string;
  version: number;
  content: string;
  scope: MemoryScope;
  kind: MemoryKind;
  provenance: string;
  source: MemorySource;
  status: MemoryStatus;
  approval: MemoryApproval;
  assertedAt: string;
  createdAt: string;
  updatedAt: string;
  reviewAfter?: string;
  projectKey?: string;
  missionId?: string;
  mission?: MemoryMission;
  conversationId?: string;
  expiresAt?: string;
  supersedes: string[];
  supersededBy: string[];
  reusable: boolean;
  uncertain?: true;
  verification?: "changed" | "missing" | "verified";
  structured?: MemoryCheckpoint;
}

export type MemoryRequest =
  | { op: "read"; id: string; projectKey?: string; missionId?: string; conversationId?: string }
  | { op: "search"; query: string; projectKey?: string; missionId?: string; conversationId?: string; limit?: number }
  | { op: "save"; operationId: string; id?: string; expectedVersion?: number; content: string;
      scope: MemoryScope; kind: MemoryKind; provenance: string; source?: MemorySource; projectKey?: string;
      missionId?: string; mission?: MemoryMission; conversationId?: string; assertedAt?: string;
      reviewAfter?: string; expiresAt?: string; reusable?: boolean; uncertain?: boolean;
      supersedes?: Array<{ id: string; expectedVersion: number }> }
  | { op: "delete"; operationId: string; id: string; expectedVersion: number; missionId?: string }
  | { op: "retire"; operationId: string; id: string; expectedVersion: number }
  | { op: "approve"; operationId: string; id: string; expectedVersion: number }
  | { op: "adopt_legacy"; operationId: string; source?: MemorySource }
  | { op: "legacy_replace"; operationId: string; expectedVersion: string; content: string }
  | { op: "observe"; operationId: string; source: Pick<MemorySource, "type" | "ref">;
      state: "completed" | "merged" | "changed" | "missing" | "verified"; revision?: string }
  | { op: "checkpoint"; operationId: string; threadId: string; projectKey?: string;
      decided: string[]; open: string[]; next: string[]; pointers: MemorySource[] }
  | { op: "brief"; threadId: string; projectKey?: string }
  | { op: "inspect"; cursor?: string; limit?: number; missionsOnly?: boolean }
  | { op: "maintain" };

export interface MemoryLimits {
  scopeRecords: number;
  scopeBytes: number;
  retainedRecords: number;
  retainedBytes: number;
}

export type MemoryResponse =
  | { status: "ok"; memory: MemoryRecord }
  | { status: "ok"; memories: MemoryRecord[]; partial?: true; nextCursor?: string }
  | { status: "ok"; checkpoint?: MemoryCheckpoint; pointers?: MemorySource[]; memory?: MemoryRecord }
  | { status: "ok"; legacy: { content: string; version: string } }
  | { status: "ok"; deleted: true }
  | { status: "ok"; more?: boolean; retired?: number }
  | { status: "consolidation_required"; limits: MemoryLimits; error: string }
  | { status: "conflict"; memory?: MemoryRecord; error: string }
  | { status: "invalid" | "forbidden" | "unavailable"; error: string };
