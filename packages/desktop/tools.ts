import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { desktopResultSchema, desktopStateSchema, type DesktopAction, type DesktopResult } from "./types";

type DesktopRequest = (path: string, init?: RequestInit) => Promise<Response>;

function stableUuid(runId: string, toolCallId: string) {
  const value = createHash("sha256").update(`${runId}\0${toolCallId}`).digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function unixRequest(socketPath: string): DesktopRequest {
  return (path, init) => fetch(`http://desktop${path}`, { ...init, unix: socketPath } as RequestInit & { unix: string });
}

async function boundedRequest(request: DesktopRequest, path: string, init: RequestInit | undefined, signal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try { return await request(path, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
}

async function safeJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

async function invoke(request: DesktopRequest, runId: string, toolCallId: string, action: DesktopAction, signal: AbortSignal, requestTimeoutMs: number) {
  try {
    const stateResponse = await boundedRequest(request, "/state", undefined, signal, Math.min(requestTimeoutMs, 2_000));
    const state = desktopStateSchema.safeParse(await safeJson(stateResponse));
    if (!stateResponse.ok || !state.success) return { error: "desktop_unavailable" };
    if (state.data.taken || !state.data.confirmed) return { error: "desktop_paused" };
    const response = await boundedRequest(request, "/actions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: stableUuid(runId, toolCallId), runId, generation: state.data.generation, action }),
    }, signal, requestTimeoutMs);
    const body = await safeJson(response);
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return { error: body.error };
    const result = body && typeof body === "object" && "result" in body ? desktopResultSchema.safeParse(body.result) : null;
    if (!response.ok || !result?.success) return { error: "desktop_unavailable" };
    return { result: result.data };
  } catch { return { error: signal.aborted ? "desktop_interrupted" : "desktop_unavailable" }; }
}

function resultContent(value: { result?: DesktopResult; error?: string }) {
  if (value.result?.kind === "screenshot") return {
    content: [
      { type: "image" as const, data: value.result.data, mimeType: value.result.mimeType },
      { type: "text" as const, text: JSON.stringify({ width: value.result.width, height: value.result.height }) },
    ], details: {},
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(value.error ? { error: value.error } : { ok: true }) }], details: {} };
}

export function desktopTools(input: { socketPath: string; runId: string; request?: DesktopRequest; requestTimeoutMs?: number }): ToolDefinition[] {
  const request = input.request ?? unixRequest(input.socketPath);
  const tool = <T>(name: string, description: string, parameters: any, action: (value: T) => DesktopAction): ToolDefinition => ({
    name, label: name.replace("desktop_", "Desktop "), description, parameters,
    async execute(toolCallId, value, signal) { return resultContent(await invoke(request, input.runId, toolCallId, action(value as T), signal ?? new AbortController().signal, input.requestTimeoutMs ?? 35_000)); },
  });
  return [
    tool("desktop_capture", "Capture the current desktop as a PNG.", Type.Object({}), () => ({ kind: "screenshot" })),
    tool<{ x: number; y: number; button?: "left" | "middle" | "right" }>("desktop_click", "Click a visible desktop coordinate once.", Type.Object({ x: Type.Number(), y: Type.Number(), button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])) }), value => ({ kind: "click", x: value.x, y: value.y, button: value.button ?? "left" })),
    tool<{ text: string; intervalMs?: number }>("desktop_type", "Type text into the focused desktop application.", Type.Object({ text: Type.String(), intervalMs: Type.Optional(Type.Number()) }), value => ({ kind: "type", text: value.text, intervalMs: value.intervalMs ?? 10 })),
    tool<{ keys: string[] }>("desktop_keys", "Press and release one key or key chord.", Type.Object({ keys: Type.Array(Type.String()) }), value => ({ kind: "key", keys: value.keys })),
    tool<{ deltaX?: number; deltaY?: number }>("desktop_scroll", "Scroll the current desktop view.", Type.Object({ deltaX: Type.Optional(Type.Number()), deltaY: Type.Optional(Type.Number()) }), value => ({ kind: "scroll", deltaX: value.deltaX ?? 0, deltaY: value.deltaY ?? 0 })),
  ];
}
