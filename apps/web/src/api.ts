import type { CompanionAvatarValue } from "@/components/CompanionAvatar";

export type CompanionStatus = "new" | "preparing" | "ready" | "error";
export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "needs_input"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface Companion {
  id: string;
  name: string;
  instructions: string;
  provider: "local" | "box";
  status: CompanionStatus;
  error: string | null;
  createdAt: string;
  avatar?: CompanionAvatarValue | null;
}

export interface AccountUser { id: string; email: string; name: string }

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  runId: string;
  files?: ThreadFile[];
}

export interface ThreadFile { id: string; runId: string; kind: "user_upload" | "agent_output"; name: string; mimeType: string; size: number; url: string }

export interface Run {
  lane?: "main"|"background";
  source?: string;
  resultText?: string|null;
  id: string;
  status: RunStatus;
  error: string | null;
  createdAt: string;
}

export interface CompanionDetail {
  questions?: Array<{id:string;runId:string;question:string;options:string[];answer:string|null}>;
  companion: Companion;
  messages: ChatMessage[];
  runs: Run[];
  activity: unknown[];
}

export interface AppConfig {
  localAvailable: boolean;
  boxAvailable: boolean;
  model: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error || `Request failed (${response.status})`, response.status);
  }

  return response.json() as Promise<T>;
}

interface PendingMessage {
  id: string;
  content: string;
  fileIds: string[];
}

const pendingMessages = new Map<string, PendingMessage>();
const pendingMessageKey = (companionId: string) => `companions.build:pending-message:${companionId}`;

function readPendingMessage(companionId: string): PendingMessage | null {
  const memoryValue = pendingMessages.get(companionId);
  if (memoryValue) return memoryValue;

  try {
    const stored = sessionStorage.getItem(pendingMessageKey(companionId));
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<PendingMessage>;
    if (typeof value.id !== "string" || typeof value.content !== "string" || !Array.isArray(value.fileIds)) return null;
    const pending = { id: value.id, content: value.content, fileIds: value.fileIds.filter((id): id is string => typeof id === "string") };
    pendingMessages.set(companionId, pending);
    return pending;
  } catch {
    return null;
  }
}

function writePendingMessage(companionId: string, pending: PendingMessage) {
  pendingMessages.set(companionId, pending);
  try {
    sessionStorage.setItem(pendingMessageKey(companionId), JSON.stringify(pending));
  } catch {
    // The in-memory copy still protects retries while this page is open.
  }
}

function clearPendingMessage(companionId: string, acknowledgedId: string) {
  if (readPendingMessage(companionId)?.id !== acknowledgedId) return;
  pendingMessages.delete(companionId);
  try {
    sessionStorage.removeItem(pendingMessageKey(companionId));
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }
}

export const api = {
  getMe: () => request<{ user: AccountUser }>("/api/me"),
  requestMagicLink: (email: string) => request<unknown>("/api/auth/sign-in/magic-link", {
    method: "POST",
    body: JSON.stringify({ email, callbackURL: "/" }),
  }),
  signOut: () => request<unknown>("/api/auth/sign-out", { method: "POST" }),
  getConfig: () => request<AppConfig>("/api/config"),
  getCompanions: () => request<{ companions: Companion[] }>("/api/companions"),
  getCompanion: (id: string) => request<CompanionDetail>(`/api/companions/${id}`),
  createCompanion: (input: Pick<Companion, "name" | "instructions" | "provider" | "avatar">) =>
    request<{ companion: Companion }>("/api/companions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sendMessage: async (id: string, content: string, files: File[] = []) => {
    const previous = readPendingMessage(id);
    const pending = previous?.content === content && previous.fileIds.length === files.length
      ? previous
      : { id: crypto.randomUUID(), content, fileIds: files.map(() => crypto.randomUUID()) };
    writePendingMessage(id, pending);

    const result = await request<{ runId: string }>(`/api/companions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ clientMessageId: pending.id, content: pending.content, attachmentCount: files.length }),
    });
    await Promise.all(files.map(async (file, position) => {
      const form = new FormData();
      form.set("file", file);
      form.set("clientFileId", pending.fileIds[position]);
      form.set("position", String(position));
      const response = await fetch(`/api/companions/${id}/runs/${result.runId}/files`, { method: "POST", credentials: "same-origin", body: form });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new ApiError(body?.error || `File upload failed (${response.status})`, response.status);
      }
    }));
    clearPendingMessage(id, pending.id);
    return result;
  },
  cancel: (id: string) =>
    request<{ ok: true }>(`/api/companions/${id}/cancel`, { method: "POST" }),
  openDesktop: (id: string) =>
    request<{ url: string }>(`/api/companions/${id}/desktop`, { method: "POST" }),
  updateCompanion: (id: string, input: Pick<Companion, "name" | "instructions" | "avatar">) =>
    request<{ companion: Companion }>(`/api/companions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
};

export interface PluginServer { id: string; name: string; description?: string; provider?: string; kind?: "oauth" | "remote" | "custom" }
export interface PluginAccount { id: string; serverId: string; label: string; provider?: string }
export interface PluginsResponse { catalog: PluginServer[]; accounts: PluginAccount[] }
export interface Routine { id: string; name: string; prompt: string; cron: string; timezone: string; enabled: boolean; nextFireAt?: string | null; createdAt?: string; updatedAt?: string }
export interface Trigger { id: string; name: string; prompt: string; source: string; mode: "direct" | "filter"; filterCode?: string | null; enabled: boolean; registrationStatus?: "manual" | "registered" | "needs_connection" | "error"; url?: string | null }

export const workspaceApi = {
  plugins: () => request<PluginsResponse>("/api/plugins"),
  connectPlugin: (serverId: string, label: string) => request<{ url?: string; account?: PluginAccount }>("/api/plugins/connect", { method: "POST", body: JSON.stringify({ serverId, label }) }),
  addCustomPlugin: (input: { label: string; url: string }) => request<{ account: PluginAccount }>("/api/plugins/custom", { method: "POST", body: JSON.stringify(input) }),
  deletePlugin: (id: string) => request<{ ok: true }>(`/api/plugins/${id}`, { method: "DELETE" }),
  companionPlugins: (id: string) => request<{ accounts: PluginAccount[] }>(`/api/companions/${id}/plugins`),
  selectPlugin: (id: string, accountId: string) => request<{ ok: true }>(`/api/companions/${id}/plugins/${accountId}`, { method: "PUT" }),
  unselectPlugin: (id: string, accountId: string) => request<{ ok: true }>(`/api/companions/${id}/plugins/${accountId}`, { method: "DELETE" }),
  routines: (id: string) => request<{ routines: Routine[] }>(`/api/companions/${id}/routines`),
  createRoutine: (id: string, input: Omit<Routine, "id">) => request<{ routine: Routine }>(`/api/companions/${id}/routines`, { method: "POST", body: JSON.stringify(input) }),
  updateRoutine: (id: string, routineId: string, input: Partial<Omit<Routine, "id">>) => request<{ routine: Routine }>(`/api/companions/${id}/routines/${routineId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteRoutine: (id: string, routineId: string) => request<{ ok: true }>(`/api/companions/${id}/routines/${routineId}`, { method: "DELETE" }),
  triggers: (id: string) => request<{ triggers: Trigger[] }>(`/api/companions/${id}/triggers`),
  createTrigger: (id: string, input: Pick<Trigger, "name" | "prompt" | "source" | "mode" | "filterCode" | "enabled">) => request<{ trigger: Trigger; secret?: string }>(`/api/companions/${id}/triggers`, { method: "POST", body: JSON.stringify(input) }),
  updateTrigger: (id: string, triggerId: string, input: Partial<Omit<Trigger, "id">>) => request<{ trigger: Trigger }>(`/api/companions/${id}/triggers/${triggerId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteTrigger: (id: string, triggerId: string) => request<{ ok: true }>(`/api/companions/${id}/triggers/${triggerId}`, { method: "DELETE" }),
};

export function isActiveRun(status: RunStatus) {
  return status === "queued" || status === "preparing" || status === "running";
}
