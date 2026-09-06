export const RUN_STATUSES = ["running", "needs_input", "succeeded", "failed", "interrupted", "cancelled"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunLane = "main" | "background";
export type TerminalRunStatus = Exclude<RunStatus, "running" | "needs_input">;

export interface RunUsage {input:number;output:number;cacheRead:number;cacheWrite:number;totalTokens:number;costUsd:number}
export interface RunProgress {previewText:string;usage:RunUsage}

export interface RunRecord {
  id: string;
  status: RunStatus;
  text: string | null;
  error: string | null;
  lane: RunLane;
  responseRootId: string;
  publishToChat: boolean;
  previewText?:string;
  usage?:RunUsage;
}

export interface RunInput {
  content: string;
  instructions: string;
  modelId?:string;
  lane?: RunLane;
}

export interface RunExecutor {
  execute(id: string, input: RunInput, onProgress?:(progress:RunProgress)=>void): Promise<{ text: string; publishToChat?: boolean }>;
  /** Native Pi steering joins an existing response; it never starts a second main session. */
  steer?(rootId: string, id: string, input: RunInput): Promise<void>;
  acceptingRoot?(lane: RunLane): string | null;
  /** Only called after the product has durably recorded a human question/answer. */
  suspend?(id: string): Promise<boolean>;
  resume?(id: string): Promise<boolean>;
  cancel(id: string): Promise<void>;
}
