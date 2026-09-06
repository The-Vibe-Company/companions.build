export const RUN_STATUSES = ["running", "needs_input", "succeeded", "failed", "interrupted", "cancelled"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunLane = "main" | "background";
export type TerminalRunStatus = Exclude<RunStatus, "running" | "needs_input">;

export interface RunRecord {
  id: string;
  status: RunStatus;
  text: string | null;
  error: string | null;
  lane: RunLane;
  responseRootId: string;
  publishToChat: boolean;
}

export interface RunInput {
  content: string;
  instructions: string;
  lane?: RunLane;
}

export interface RunExecutor {
  execute(id: string, input: RunInput): Promise<{ text: string; publishToChat?: boolean }>;
  /** Native Pi steering joins an existing response; it never starts a second main session. */
  steer?(rootId: string, id: string, input: RunInput): Promise<void>;
  acceptingRoot?(lane: RunLane): string | null;
  /** Only called after the product has durably recorded a human question/answer. */
  suspend?(id: string): Promise<boolean>;
  resume?(id: string): Promise<boolean>;
  cancel(id: string): Promise<void>;
}
