import { resolve } from "node:path";

export const FILTER_IMAGE = "node:22.20.0-alpine3.22@sha256:dbcedd8aeab47fbc0f4dd4bffa55b7c3c729a707875968d467aaaea42d6225af";
export const FILTER_TIMEOUT_MS = 2_000;

export class FilterExecutionError extends Error {
  constructor(message = "The trigger filter could not be evaluated.") { super(message); }
}

export interface FilterInput { code: string; payload: unknown; responses?: Record<string, unknown> }
interface FilterProcess {
  stdin: { write(value: string): number; flush(): number | Promise<number>; end(): void };
  stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void;
}

export async function runFilter(input: FilterInput, options: { docker?: string; entryPath?: string } = {}): Promise<boolean> {
  if (typeof input.code !== "string" || !input.code.trim() || input.code.length > 20_000) throw new FilterExecutionError();
  const entry = await Bun.file(options.entryPath ?? resolve(import.meta.dir, "entry.cjs")).text();
  const body = JSON.stringify({ code: input.code, payload: input.payload, responses: input.responses ?? {} });
  if (body.length > 400_000) throw new FilterExecutionError();
  const docker = options.docker ?? Bun.which("docker");
  if (!docker) throw new FilterExecutionError("The trigger filter runtime is unavailable.");
  let child: FilterProcess;
  try { child = Bun.spawn([
    docker, "run", "--rm", "--interactive", "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "32",
    "--memory", "128m", "--cpus", "0.25", "--user", "65534:65534",
    FILTER_IMAGE, "node", "-e", entry,
  ], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: {} }) as unknown as FilterProcess; }
  catch { throw new FilterExecutionError("The trigger filter runtime is unavailable."); }
  const timer = setTimeout(() => child.kill(), FILTER_TIMEOUT_MS);
  try {
    child.stdin.write(body);
    await child.stdin.flush();
    child.stdin.end();
    const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (exit !== 0) throw new FilterExecutionError();
    const parsed = JSON.parse(output);
    if (typeof parsed.accepted !== "boolean") throw new FilterExecutionError();
    return parsed.accepted;
  } catch (error) {
    if (error instanceof FilterExecutionError) throw error;
    throw new FilterExecutionError();
  } finally {
    clearTimeout(timer);
  }
}
