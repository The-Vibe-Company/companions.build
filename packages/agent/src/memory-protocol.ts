export type MemoryScope = "user" | "companion" | "project";
export type MemoryKind = "fact" | "preference" | "correction" | "procedure" | "context";

export interface MemoryRecord {
  id: string;
  version: number;
  content: string;
  scope: MemoryScope;
  kind: MemoryKind;
  provenance: string;
  createdAt: string;
  updatedAt: string;
  projectKey?: string;
  missionId?: string;
  expiresAt?: string;
  reusable: boolean;
}

export type MemoryRequest =
  | { op: "read"; id: string; missionId?: string }
  | { op: "search"; query: string; projectKey?: string; missionId?: string; limit?: number }
  | { op: "save"; operationId: string; id?: string; expectedVersion?: number; content: string;
      scope: MemoryScope; kind: MemoryKind; provenance: string; projectKey?: string;
      missionId?: string; expiresAt?: string; reusable?: boolean }
  | { op: "delete"; operationId: string; id: string; expectedVersion: number; missionId?: string }
  | { op: "maintain" };

export type MemoryResponse =
  | { status: "ok"; memory: MemoryRecord }
  | { status: "ok"; memories: MemoryRecord[]; partial?: true }
  | { status: "ok"; deleted: true }
  | { status: "ok"; more?: boolean }
  | { status: "conflict"; memory?: MemoryRecord; error: string }
  | { status: "invalid"; error: string }
  | { status: "unavailable"; error: string };
