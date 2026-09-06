import type { CompanionAvatarValue } from "@/components/CompanionAvatar";

export type CompanionStatus = "new" | "preparing" | "ready" | "error";
export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
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
}

export interface Run {
  id: string;
  status: RunStatus;
  error: string | null;
  createdAt: string;
}

export interface CompanionDetail {
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
    if (typeof value.id !== "string" || typeof value.content !== "string") return null;
    const pending = { id: value.id, content: value.content };
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
  sendMessage: async (id: string, content: string) => {
    const previous = readPendingMessage(id);
    const pending = previous?.content === content
      ? previous
      : { id: crypto.randomUUID(), content };
    writePendingMessage(id, pending);

    const result = await request<{ runId: string }>(`/api/companions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ clientMessageId: pending.id, content: pending.content }),
    });
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

export function isActiveRun(status: RunStatus) {
  return status === "queued" || status === "preparing" || status === "running";
}
