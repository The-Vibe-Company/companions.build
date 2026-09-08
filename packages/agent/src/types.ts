export const RUN_STATUSES = ["running", "needs_input", "succeeded", "failed", "interrupted", "cancelled"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunLane = "main" | "background";
export type TerminalRunStatus = Exclude<RunStatus, "running" | "needs_input">;

export interface RunUsage {input:number;output:number;cacheRead:number;cacheWrite:number;totalTokens:number;costUsd:number}
export interface RunMessage {sequence:number;text:string;createdAt:string;complete:boolean}
export interface RunProgress {thinkingText?:string;previewText:string;usage:RunUsage;messages?:RunMessage[];messageVersion?:number}

export interface RunRecord {
  id: string;
  status: RunStatus;
  text: string | null;
  error: string | null;
  lane: RunLane;
  responseRootId: string;
  publishToChat: boolean;
  previewText?:string;
  thinkingText?:string;
  usage?:RunUsage;
  messages?:RunMessage[];
  messageVersion?:number;
  initWarning?: string;
}

export interface RunInput {
  content: string;
  instructions: string;
  modelId?:string;
  /** Immutable specialist initialization, journaled once per Companion state directory. */
  initScript?: string;
  /** Server-resolved administrative timeout; defaults to ten minutes. */
  initTimeoutMs?: number;
  lane?: RunLane;
  /** Short-lived, run-bound credential. It is intentionally never written to the run journal. */
  modelGateway?: {token:string};
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
