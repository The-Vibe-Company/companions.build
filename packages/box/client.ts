export class BoxError extends Error {
  constructor(public code: string, public status = 0) { super(code); }
}
export type Box = { id: string; state: string; setupStatus?: string; archiveAfter?: string; updatedAt?: string };
/** Only provider transport. Durable lifecycle decisions belong to the executor. */
export class BoxClient {
  constructor(private key: string, private transport: typeof fetch = fetch, private base = "https://ascii.dev/api/box/v1") {}
  async request(path: string, method = "GET", body?: unknown, headers?: Record<string, string>): Promise<any> {
    let response: Response;
    try {
      response = await this.transport(`${this.base}${path}`, { method,
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    } catch { throw new BoxError("box_unreachable"); }
    if (!response.ok) throw new BoxError(response.status === 404 ? "box_not_found" : "box_request_failed", response.status);
    try { return await response.json(); } catch { throw new BoxError("box_invalid_response"); }
  }
  private parseBox(value: any): Box {
    if (!value?.box || typeof value.box.id !== "string" || typeof value.box.state !== "string") throw new BoxError("box_invalid_response");
    const timestamp=(raw:unknown)=>typeof raw==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(raw)&&Number.isFinite(Date.parse(raw))?new Date(raw).toISOString():undefined;
    return { id: value.box.id, state: value.box.state, setupStatus: value.box.setupStatus ?? value.setupStatus,
      archiveAfter:timestamp(value.box.archiveAfter),updatedAt:timestamp(value.box.updatedAt) };
  }
  async create(key: string, template?: string) {
    return this.parseBox(await this.request("/boxes", "POST", { noEnv: true, type: "small", ttlSeconds: 21600, ...(template ? { from: template } : {}) }, { "Idempotency-Key": key }));
  }
  async get(id: string) { return this.parseBox(await this.request(`/boxes/${encodeURIComponent(id)}`)); }
  async resume(id: string) { await this.request(`/boxes/${encodeURIComponent(id)}/resume`, "POST", { noEnv: true, ttlSeconds: 21600 }); }
  async command(id: string, command: string, timeoutSeconds = 30) {
    const result = await this.request(`/boxes/${encodeURIComponent(id)}/commands`, "POST", { command, timeoutSeconds });
    if (result.success !== true || result.exitCode !== 0 || typeof result.stdout !== "string") throw new BoxError("box_command_failed");
    return result.stdout as string;
  }
  async writeFile(id: string, path: string, content: string, encoding = "utf8") { await this.request(`/boxes/${encodeURIComponent(id)}/files`, "PUT", { path, content, encoding }); }
  async host(id: string, port: number) {
    const output = await this.command(id, `host ${port} --private --title companions >/dev/null && host url ${port}`);
    const raw = output.match(/https:\/\/[^\s"'<>]+/)?.[0];
    if (!raw) throw new BoxError("box_host_unavailable");
    const url = new URL(raw);
    if (!url.hostname.endsWith(".on.ascii.dev") || !url.searchParams.has("_token")) throw new BoxError("box_host_invalid");
    return url.href;
  }
  async desktop(id: string) {
    const data = await this.request(`/boxes/${encodeURIComponent(id)}/desktop?vnc=1`, "POST", {});
    if (!data.success || typeof data.desktopUrl !== "string") throw new BoxError("desktop_preparing");
    const url = new URL(data.desktopUrl);
    if (url.protocol !== "https:") throw new BoxError("desktop_invalid");
    return url.href;
  }
  async snapshot(id: string, name: string) { return this.request("/named-snapshots", "POST", { boxId: id, name }); }
  async getSnapshot(name: string) { return this.request(`/named-snapshots/${encodeURIComponent(name)}`); }
  async stop(id: string) { await this.request(`/boxes/${encodeURIComponent(id)}/stop`, "POST", { force: false }); }
}
