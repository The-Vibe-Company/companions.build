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
}

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

export const api = {
  getConfig: () => request<AppConfig>("/api/config"),
  getCompanions: () => request<{ companions: Companion[] }>("/api/companions"),
  getCompanion: (id: string) => request<CompanionDetail>(`/api/companions/${id}`),
  createCompanion: (input: Pick<Companion, "name" | "instructions" | "provider">) =>
    request<{ companion: Companion }>("/api/companions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sendMessage: (id: string, content: string) =>
    request<{ runId: string }>(`/api/companions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ clientMessageId: crypto.randomUUID(), content }),
    }),
  cancel: (id: string) =>
    request<{ ok: true }>(`/api/companions/${id}/cancel`, { method: "POST" }),
  openDesktop: (id: string) =>
    request<{ url: string }>(`/api/companions/${id}/desktop`, { method: "POST" }),
  createSession: (token: string) =>
    request<unknown>("/api/session", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
};

export function isActiveRun(status: RunStatus) {
  return status === "queued" || status === "preparing" || status === "running";
}
