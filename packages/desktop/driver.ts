import type { DesktopAction, DesktopDriver, DesktopResult } from "./types";

export type CommandRunner = (argv: readonly string[], signal?: AbortSignal, timeoutMs?: number) => Promise<Uint8Array>;

export interface CommandDesktopDriverOptions {
  display?: string;
  xdotoolPath?: string;
  capturePath?: string;
  quiescePath?: string;
  home?: string;
  actionTimeoutMs?: number;
  commandTimeoutMs?: number;
  killGraceMs?: number;
  runCommand?: CommandRunner;
}

function absoluteExecutable(path: string) {
  if (!path.startsWith("/") || path.includes("\0")) throw new Error("Desktop executables must use absolute paths");
  return path;
}

function pngSize(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)
    || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") throw new Error("Capture did not return a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16); const height = view.getUint32(20);
  if (!width || !height || width > 16_384 || height > 16_384 || bytes.length > 20 * 1024 * 1024) throw new Error("Capture is outside desktop bounds");
  return { width, height };
}

function chunks(value: string, length = 128) {
  const characters = [...value];
  return Array.from({ length: Math.ceil(characters.length / length) }, (_, index) => characters.slice(index * length, (index + 1) * length).join(""));
}

export class CommandDesktopDriver implements DesktopDriver {
  private readonly display: string;
  private readonly xdotool: string;
  private readonly capture: string;
  private readonly quiesceHelper: string;
  private readonly runCommand: CommandRunner;
  private readonly actionTimeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(options: CommandDesktopDriverOptions = {}) {
    this.display = options.display ?? ":0";
    this.xdotool = absoluteExecutable(options.xdotoolPath ?? "/usr/bin/xdotool");
    this.capture = absoluteExecutable(options.capturePath ?? "/usr/local/bin/companions-desktop-capture");
    this.quiesceHelper = absoluteExecutable(options.quiescePath ?? "/usr/local/bin/companions-desktop-quiesce");
    this.actionTimeoutMs = options.actionTimeoutMs ?? 30_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    const killGraceMs = options.killGraceMs ?? 500;
    const environment = { DISPLAY: this.display, HOME: options.home ?? "/home/desktop", PATH: "/usr/bin:/bin" };
    this.runCommand = options.runCommand ?? (async (argv, signal, timeoutMs = this.commandTimeoutMs) => {
      const child = Bun.spawn({ cmd: [...argv], env: environment, stdout: "pipe", stderr: "ignore", detached: true });
      let stopped = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const killGroup = (signalName: NodeJS.Signals) => {
        try { process.kill(-child.pid, signalName); } catch { try { child.kill(signalName); } catch {} }
      };
      const terminate = () => {
        if (stopped) return;
        stopped = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
      };
      signal?.addEventListener("abort", terminate, { once: true });
      const timeout = setTimeout(terminate, timeoutMs);
      try {
        const [output, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
        if (stopped || signal?.aborted) throw new DOMException("Desktop command interrupted", "AbortError");
        if (code !== 0) throw new Error("Desktop command failed");
        return new Uint8Array(output);
      } finally {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", terminate);
      }
    });
  }

  private command(args: readonly string[], signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Desktop action interrupted", "AbortError");
    return this.runCommand([this.xdotool, ...args], signal, this.commandTimeoutMs);
  }

  async quiesce() {
    await this.runCommand([this.quiesceHelper], undefined, this.commandTimeoutMs);
  }

  async execute(action: DesktopAction, signal: AbortSignal): Promise<DesktopResult> {
    const actionController = new AbortController();
    const abort = () => actionController.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.actionTimeoutMs);
    const boundedSignal = actionController.signal;
    if (action.kind === "screenshot") {
      try {
        const bytes = await this.runCommand([this.capture], boundedSignal, this.commandTimeoutMs);
        const { width, height } = pngSize(bytes);
        return { kind: "screenshot", mimeType: "image/png", data: Buffer.from(bytes).toString("base64"), width, height };
      } finally {
        clearTimeout(timeout); signal.removeEventListener("abort", abort);
      }
    }
    try {
      if (action.kind === "click") {
        const button = { left: "1", middle: "2", right: "3" }[action.button];
        await this.command(["mousemove", "--sync", String(action.x), String(action.y), "click", button], boundedSignal);
      } else if (action.kind === "type") {
        for (const chunk of chunks(action.text)) await this.command(["type", "--clearmodifiers", "--delay", String(action.intervalMs), "--", chunk], boundedSignal);
      } else if (action.kind === "key") {
        await this.command(["key", "--clearmodifiers", action.keys.join("+")], boundedSignal);
      } else {
        const steps: Array<[number, string]> = [[action.deltaY, action.deltaY < 0 ? "4" : "5"], [action.deltaX, action.deltaX < 0 ? "6" : "7"]];
        for (const [delta, button] of steps) if (delta) await this.command(["click", "--repeat", String(Math.abs(delta)), "--delay", "20", button], boundedSignal);
      }
      return { kind: "ok" };
    } finally {
      clearTimeout(timeout); signal.removeEventListener("abort", abort);
      // The fixed helper releases every pressed key/button and completes XSync before returning.
      await this.quiesce();
    }
  }
}
