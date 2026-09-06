export const RUN_STATUSES = ["running", "succeeded", "failed", "interrupted", "cancelled"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunRecord {
  id: string;
  status: RunStatus;
  text: string | null;
  error: string | null;
}

export interface RunInput {
  content: string;
  instructions: string;
}

export interface RunExecutor {
  execute(id: string, input: RunInput): Promise<{ text: string }>;
  cancel(id: string): Promise<void>;
}
