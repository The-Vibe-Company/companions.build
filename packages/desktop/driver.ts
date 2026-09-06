import type { DesktopAction, DesktopDriver, DesktopResult } from "./types";

export type CommandRunner = (argv: readonly string[], signal?: AbortSignal) => Promise<Uint8Array>;

export interface CommandDesktopDriverOptions {
  display?: string;
  xdotoolPath?: string;
  capturePath?: string;
  home?: string;
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
  private readonly runCommand: CommandRunner;

  constructor(options: CommandDesktopDriverOptions = {}) {
    this.display = options.display ?? ":0";
    this.xdotool = absoluteExecutable(options.xdotoolPath ?? "/usr/bin/xdotool");
    this.capture = absoluteExecutable(options.capturePath ?? "/usr/local/bin/companions-desktop-capture");
    const environment = { DISPLAY: this.display, HOME: options.home ?? "/home/desktop", PATH: "/usr/bin:/bin" };
    this.runCommand = options.runCommand ?? (async (argv, signal) => {
      const child = Bun.spawn({ cmd: [...argv], env: environment, stdout: "pipe", stderr: "ignore" });
      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const [output, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
        if (signal?.aborted) throw new DOMException("Desktop action interrupted", "AbortError");
        if (code !== 0) throw new Error("Desktop command failed");
        return new Uint8Array(output);
      } finally { signal?.removeEventListener("abort", abort); }
    });
  }

  private command(args: readonly string[], signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Desktop action interrupted", "AbortError");
    return this.runCommand([this.xdotool, ...args], signal);
  }

  async quiesce() {
    await this.command(["keyup", "Shift_L", "Control_L", "Alt_L", "Super_L", "mouseup", "1", "mouseup", "2", "mouseup", "3", "getmouselocation"]);
  }

  async execute(action: DesktopAction, signal: AbortSignal): Promise<DesktopResult> {
    if (action.kind === "screenshot") {
      const bytes = await this.runCommand([this.capture], signal);
      const { width, height } = pngSize(bytes);
      return { kind: "screenshot", mimeType: "image/png", data: Buffer.from(bytes).toString("base64"), width, height };
    }
    try {
      if (action.kind === "click") {
        const button = { left: "1", middle: "2", right: "3" }[action.button];
        await this.command(["mousemove", "--sync", String(action.x), String(action.y), "click", button], signal);
      } else if (action.kind === "type") {
        for (const chunk of chunks(action.text)) await this.command(["type", "--clearmodifiers", "--delay", String(action.intervalMs), "--", chunk], signal);
      } else if (action.kind === "key") {
        await this.command(["key", "--clearmodifiers", action.keys.join("+")], signal);
      } else {
        const steps: Array<[number, string]> = [[action.deltaY, action.deltaY < 0 ? "4" : "5"], [action.deltaX, action.deltaX < 0 ? "6" : "7"]];
        for (const [delta, button] of steps) if (delta) await this.command(["click", "--repeat", String(Math.abs(delta)), "--delay", "20", button], signal);
      }
      return { kind: "ok" };
    } finally {
      // Release common modifiers and buttons and perform an X11 round trip before acknowledgement.
      await this.quiesce();
    }
  }
}
