import type { CompanionAvatarValue } from "@/components/CompanionAvatar";

export type CompanionStatus = "new" | "preparing" | "ready" | "archived" | "error";
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
  desktopTaken?: boolean;
  desktopPausedAt?: string | null;
  prepareRequested?: boolean;
  readyAt?: string | null;
  parentId?: string | null;
  temporary?: boolean;
  templateId?: string | null;
  templateRevision?: number | null;
  retiredAt?: string | null;
  modelId?: string | null;
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
  previewText?: string|null;
  id: string;
  status: RunStatus;
  error: string | null;
  createdAt: string;
}

export interface CompanionDetail {
  files?: ThreadFile[];
  questions?: Array<{id:string;runId:string;question:string;options:string[];answer:string|null}>;
  specialists?: Array<{
    delegationId: string;
    parentRunId: string;
    childRunId: string;
    companion: Pick<Companion, "id" | "name" | "avatar" | "status" | "retiredAt">;
  }>;
  companion: Companion;
  messages: ChatMessage[];
  runs: Run[];
  activity: unknown[];
}

export interface AppConfig {
  localAvailable: boolean;
  boxAvailable: boolean;
  model: string;
  models?: Array<{ id: string; name: string }>;
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
  companionEvents: (id: string) => new EventSource(`/api/companions/${id}/events`),
  createCompanion: (input: Pick<Companion, "name" | "instructions" | "provider" | "avatar"> & { clientCreationId: string; prepare?: boolean; templateId?: string; templateRevision?: number }) =>
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
    request<{ url?: string; preparing?: true }>(`/api/companions/${id}/desktop`, { method: "POST" }),
  updateCompanion: (id: string, input: Pick<Companion, "name" | "instructions" | "avatar"> & { modelId?: string | null }) =>
    request<{ companion: Companion }>(`/api/companions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
};

export interface PluginServer { id: string; name: string; description?: string; provider?: string; kind?: "oauth" | "remote" | "custom"; available: boolean }
export type PluginHealthCode = "authorization_required" | "connection_failed" | "configuration_invalid" | "agent_check_required";
export interface PluginAccount { id: string; serverId: string | null; label: string; provider?: string; healthStatus: "unchecked" | "ok" | "error" | "requires_agent"; healthCode: PluginHealthCode | null; checkedAt: string | null }
export type PluginHealthResult = Pick<PluginAccount, "id" | "healthStatus" | "healthCode" | "checkedAt">;
export interface PluginsResponse { catalog: PluginServer[]; accounts: PluginAccount[] }
export type CustomPluginInput =
  | { label: string; transport: "http"; url: string; headers: Record<string, string> }
  | { label: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string> };
export interface Routine { id: string; name: string; prompt: string; cron: string; timezone: string; enabled: boolean; nextFireAt?: string | null; createdAt?: string; updatedAt?: string }
export interface RoutineHistory { runs: Array<{ id: string; status: RunStatus; resultText: string | null; error: string | null; scheduledFor: string; acceptedAt: string }>; missed: Array<{ firstScheduledFor: string; lastScheduledFor: string; cron: string; timezone: string }> }
export interface TriggerFilterRequest { key: string; provider: "github" | "sentry"; connectionId?: string; path: string }
export interface TriggerTarget { repo?: string; branch?: string; organization?: string; project?: string; events?: string[] }
export interface Trigger { id: string; name: string; prompt: string; source: "generic" | "github" | "sentry"; mode: "direct" | "filter"; filter?: string | null; filterRequests?: TriggerFilterRequest[]; problemPath?: string | null; providerAccountId?: string | null; target?: TriggerTarget | null; enabled: boolean; registrationStatus?: "manual" | "registered" | "needs_connection" | "error"; registrationError?: string | null; url?: string | null; lastDeliveryAt?: string | null }
export interface TriggerDelivery { id: string; eventName: string | null; payload: unknown; status: "received" | "evaluating" | "ignored" | "enqueued" | "error"; decision: string | null; errorCode: string | null; receivedAt: string; decidedAt: string | null; batchId: string | null; runId: string | null }
export interface BillingOverview { configured: boolean; mode: "unconfigured" | "test" | "stripe"; plan: "inactive" | "subscription"; active: boolean; status: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; portalAvailable: boolean; usage: Array<{ category: string; unit: string; quantity: string }> }
export type DeliverySkillsStatus = "pending" | "ready" | "error";
export type DeliverySoftwareStatus = "pending" | "ready" | "error";
interface DeliveryState { status: "pending" | "accepted" | "revoked"; skillsStatus: DeliverySkillsStatus; skillsError: string | null; softwareStatus: DeliverySoftwareStatus; softwareError: string | null; maintenanceRequested: boolean; expiresAt: string; acceptedAt: string | null; companionId: string | null }
export interface DeliverySent extends DeliveryState { id: string; clientEmail: string }
export interface DeliveryReceived extends DeliveryState { id: string; name: string }
export interface AgentTemplate { id: string; name: string; instructions: string; avatar: CompanionAvatarValue; revision: number; sourceCompanionId: string | null; softwareBuildId?: string | null; softwareResultId?: string | null; hasSnapshot: boolean }
export interface CompanionTemplatePermission { templateId: string; maxChildren: number; name: string; revision: number }
export interface AgentTemplateRevision { revision: number; name: string; instructions: string; avatar: CompanionAvatarValue; snapshotName: string | null; sourceCompanionId: string | null; softwareBuildId?: string | null; softwareResultId?: string | null; createdAt: string }
export interface TemplateSoftwareStatus { templateId: string; templateRevision: number; build: null | { id: string; status: "queued" | "creating" | "resolving" | "installing" | "verifying" | "capturing" | "ready" | "failed"; verified: boolean; errorCode: string | null }; result: null | { id: string; verified: true } }
export interface MaintenanceCompanion { id: string; name: string; avatar?: CompanionAvatarValue; status: string; error: string | null; grantId: string }
export interface MaintenanceDetail { id: string; name: string; instructions: string; avatar?: CompanionAvatarValue; modelId: string | null; status: string; error: string | null; readyAt: string | null }
export interface MaintenanceAction { id: string; operation: string; createdAt: string; status: string; error: string | null }

export const workspaceApi = {
  plugins: () => request<PluginsResponse>("/api/plugins"),
  checkPlugin: (id: string) => request<{ account: PluginHealthResult }>(`/api/plugins/accounts/${id}/check`, { method: "POST" }),
  connectPlugin: (serverId: string, label: string) => request<{ url?: string; account?: PluginAccount }>("/api/plugins/connect", { method: "POST", body: JSON.stringify({ serverId, label }) }),
  addCustomPlugin: (input: CustomPluginInput) => request<{ id: string }>("/api/plugins/custom", { method: "POST", body: JSON.stringify(input) }),
  deletePlugin: (id: string) => request<{ ok: true }>(`/api/plugins/${id}`, { method: "DELETE" }),
  companionPlugins: (id: string) => request<{ accounts: PluginAccount[] }>(`/api/companions/${id}/plugins`),
  selectPlugin: (id: string, accountId: string) => request<{ ok: true }>(`/api/companions/${id}/plugins/${accountId}`, { method: "PUT" }),
  unselectPlugin: (id: string, accountId: string) => request<{ ok: true }>(`/api/companions/${id}/plugins/${accountId}`, { method: "DELETE" }),
  routines: (id: string) => request<{ routines: Routine[] }>(`/api/companions/${id}/routines`),
  createRoutine: (id: string, input: Omit<Routine, "id">) => request<{ routine: Routine }>(`/api/companions/${id}/routines`, { method: "POST", body: JSON.stringify(input) }),
  updateRoutine: (id: string, routineId: string, input: Partial<Omit<Routine, "id">>) => request<{ routine: Routine }>(`/api/companions/${id}/routines/${routineId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteRoutine: (id: string, routineId: string) => request<{ ok: true }>(`/api/companions/${id}/routines/${routineId}`, { method: "DELETE" }),
  routineHistory: (id: string, routineId: string) => request<RoutineHistory>(`/api/companions/${id}/routines/${routineId}/history`),
  testRoutine: (id: string, routineId: string, clientMessageId: string) => request<{ runId: string }>(`/api/companions/${id}/routines/${routineId}/test`, { method: "POST", body: JSON.stringify({ clientMessageId }) }),
  triggers: (id: string) => request<{ triggers: Trigger[] }>(`/api/companions/${id}/triggers`),
  createTrigger: (id: string, input: Omit<Trigger, "id" | "registrationStatus" | "registrationError" | "url" | "lastDeliveryAt">) => request<{ trigger: Trigger; secret?: string }>(`/api/companions/${id}/triggers`, { method: "POST", body: JSON.stringify(input) }),
  updateTrigger: (id: string, triggerId: string, input: Partial<Omit<Trigger, "id">>) => request<{ trigger: Trigger }>(`/api/companions/${id}/triggers/${triggerId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteTrigger: (id: string, triggerId: string) => request<{ ok: true }>(`/api/companions/${id}/triggers/${triggerId}`, { method: "DELETE" }),
  testTrigger: (id: string, triggerId: string, payload: unknown) => request<{ decision: "trigger" | "ignore" }>(`/api/companions/${id}/triggers/${triggerId}/test`, { method: "POST", body: JSON.stringify(payload) }),
  registerTrigger: (id: string, triggerId: string) => request<{ trigger: Trigger }>(`/api/companions/${id}/triggers/${triggerId}/register`, { method: "POST" }),
  triggerDeliveries: (id: string, triggerId: string) => request<{ deliveries: TriggerDelivery[] }>(`/api/companions/${id}/triggers/${triggerId}/deliveries`),
  billing: () => request<BillingOverview>("/api/billing"),
  checkout: () => request<{ url: string }>("/api/billing/checkout", { method: "POST" }),
  billingPortal: () => request<{ url: string }>("/api/billing/portal", { method: "POST" }),
  deliveries: () => request<{ sent: DeliverySent[]; received: DeliveryReceived[] }>("/api/deliveries"),
  createDelivery: (input: { clientDeliveryId: string; companionId: string; clientEmail: string; templateIds: string[]; maintenanceRequested: boolean; includeSkills?: boolean }) => request<{ delivery: DeliverySent }>("/api/deliveries", { method: "POST", body: JSON.stringify(input) }),
  acceptDelivery: (id: string, grantMaintenance: boolean) => request<{ companionId: string; accepted: boolean }>(`/api/deliveries/${id}/accept`, { method: "POST", body: JSON.stringify({ grantMaintenance }) }),
  revokeDelivery: (id: string) => request<{ revoked: true }>(`/api/deliveries/${id}`, { method: "DELETE" }),
  revokeMaintenance: (id: string) => request<{ revoked: true }>(`/api/deliveries/${id}/maintenance`, { method: "DELETE" }),
  templates: () => request<{ templates: AgentTemplate[] }>("/api/templates"),
  companionTemplates: (companionId: string) => request<{ templates: CompanionTemplatePermission[] }>(`/api/companions/${companionId}/templates`),
  createTemplate: (input: Pick<AgentTemplate, "name" | "instructions" | "avatar">) => request<{ id: string; revision: number }>("/api/templates", { method: "POST", body: JSON.stringify(input) }),
  updateTemplate: (id: string, input: Pick<AgentTemplate, "name" | "instructions" | "avatar" | "revision">) => request<{ id: string; revision: number }>(`/api/templates/${id}`, { method: "PATCH", body: JSON.stringify({ name: input.name, instructions: input.instructions, avatar: input.avatar, expectedRevision: input.revision }) }),
  templateRevisions: (id: string) => request<{ revisions: AgentTemplateRevision[] }>(`/api/templates/${id}/revisions`),
  templateSoftwareStatus: (id: string) => request<TemplateSoftwareStatus>(`/api/templates/${id}/software/status`),
  rollbackTemplate: (id: string, targetRevision: number, expectedRevision: number) => request<{ id: string; revision: number }>(`/api/templates/${id}/rollback`, { method: "POST", body: JSON.stringify({ targetRevision, expectedRevision }) }),
  setTemplatePermission: (companionId: string, templateId: string, maxChildren: number) => request<{ templateId: string; maxChildren: number }>(`/api/companions/${companionId}/templates/${templateId}`, { method: "PUT", body: JSON.stringify({ maxChildren }) }),
  replicas: (companionId: string) => request<{ replicas: Companion[] }>(`/api/companions/${companionId}/replicas`),
  spawnReplica: (companionId: string, templateId: string, prompt: string, clientCommandId: string = crypto.randomUUID()) => request<{ companionId: string; runId: string }>(`/api/companions/${companionId}/replicas`, { method: "POST", body: JSON.stringify({ clientCommandId, templateId, prompt }) }),
  prepare: (companionId: string) => request<unknown>(`/api/companions/${companionId}/prepare`, { method: "POST" }),
  takeDesktop: (companionId: string) => request<unknown>(`/api/companions/${companionId}/desktop/takeover`, { method: "POST" }),
  releaseDesktop: (companionId: string) => request<unknown>(`/api/companions/${companionId}/desktop/release`, { method: "POST" }),
  maintenance: () => request<{ companions: MaintenanceCompanion[] }>("/api/maintenance"),
  maintenanceDetail: (id: string) => request<{ companion: MaintenanceDetail }>(`/api/maintenance/companions/${id}`),
  updateMaintenanceCompanion: (id: string, input: { name: string; instructions: string; modelId?: string | null }) => request<{ companion: MaintenanceDetail }>(`/api/maintenance/companions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  prepareMaintenanceCompanion: (id: string) => request<unknown>(`/api/maintenance/companions/${id}/prepare`, { method: "POST" }),
  createMaintenanceTask: (id: string, clientMessageId: string, prompt: string) => request<{ runId?: string }>(`/api/maintenance/companions/${id}/tasks`, { method: "POST", body: JSON.stringify({ clientMessageId, prompt }) }),
  maintenanceActions: (id: string) => request<{ actions: MaintenanceAction[] }>(`/api/maintenance/companions/${id}/actions`),
};

export function isActiveRun(status: RunStatus) {
  return status === "queued" || status === "preparing" || status === "running" || status === "needs_input";
}
