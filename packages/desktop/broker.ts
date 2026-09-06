import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DesktopJournal } from "./journal";
import { desktopActionRequestSchema, desktopAdminStateSchema, type DesktopActionRequest, type DesktopDriver, type DesktopState } from "./types";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export class DesktopBroker {
  readonly bootId = crypto.randomUUID();
  private readonly journal: DesktopJournal;
  private generation: number;
  private reconciled = false;
  private taken = true;
  private confirmed = false;
  private active: { request: DesktopActionRequest; controller: AbortController; promise: Promise<Response> } | null = null;
  private actionTail: Promise<void> = Promise.resolve();
  private adminTail: Promise<void> = Promise.resolve();

  constructor(path: string, private readonly driver: DesktopDriver) {
    this.journal = new DesktopJournal(path);
    const state = this.journal.desiredState();
    this.generation = state.generation;
  }

  state(): DesktopState {
    return { generation: this.generation, taken: this.taken, confirmed: this.confirmed, bootId: this.bootId };
  }

  async handleAgent(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/state" && request.method === "GET") return json(this.state());
    if (url.pathname !== "/actions" || request.method !== "POST") return json({ error: "not_found" }, 404);
    let input: DesktopActionRequest;
    try { input = desktopActionRequestSchema.parse(await request.json()); }
    catch { return json({ error: "invalid_action" }, 400); }
    const previous = this.journal.previous(input);
    if (previous?.state === "conflict") return json({ error: "action_id_conflict" }, 409);
    if (previous?.state === "expired") return json({ error: "result_expired" }, 409);
    if (previous?.state === "interrupted") return json({ error: "ambiguous_action" }, 409);
    if (previous?.state === "in_progress") return json({ error: "action_in_progress" }, 409);
    if (previous?.state === "succeeded") return json({ result: previous.result });
    if (!this.reconciled || this.taken) return json({ error: "desktop_paused", generation: this.generation }, 423);
    if (input.generation !== this.generation) return json({ error: "stale_generation", generation: this.generation }, 409);
    return this.serializeAction(async () => {
      if (!this.reconciled || this.taken) return json({ error: "desktop_paused", generation: this.generation }, 423);
      if (input.generation !== this.generation) return json({ error: "stale_generation", generation: this.generation }, 409);
      const claim = this.journal.claim(input);
      if (claim.state === "conflict") return json({ error: "action_id_conflict" }, 409);
      if (claim.state === "expired") return json({ error: "result_expired" }, 409);
      if (claim.state === "interrupted") return json({ error: "ambiguous_action" }, 409);
      if (claim.state === "in_progress") return json({ error: "action_in_progress" }, 409);
      if (claim.state === "succeeded") return json({ result: claim.result });
      const controller = new AbortController();
      const promise = (async () => {
        try {
          const result = await this.driver.execute(input.action, controller.signal);
          this.journal.succeed(input.id, result);
          return json({ result });
        } catch {
          this.journal.interrupt(input.id);
          return json({ error: "ambiguous_action" }, 409);
        }
      })();
      this.active = { request: input, controller, promise };
      try { return await promise; }
      finally { if (this.active?.request.id === input.id) this.active = null; }
    });
  }

  async handleAdmin(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/state" || request.method !== "PUT") return json({ error: "not_found" }, 404);
    let input: { generation: number; taken: boolean };
    try { input = desktopAdminStateSchema.parse(await request.json()); }
    catch { return json({ error: "invalid_state" }, 400); }
    return this.serializeAdmin(async () => {
      const outcome = this.journal.reconcile(input.generation, input.taken);
      if (outcome === "stale") return json({ error: "stale_generation", generation: this.generation }, 409);
      if (outcome === "conflict") return json({ error: "generation_conflict", generation: this.generation }, 409);
      if (outcome === "advanced" || !this.reconciled) {
        // Fence work admitted under the preceding epoch before reopening, even if the desired
        // state remains released.
        this.taken = true;
        this.confirmed = false;
        const active = this.active;
        active?.controller.abort();
        if (active) await active.promise;
        try { await this.driver.quiesce(); }
        catch {
          this.generation = input.generation;
          this.reconciled = false;
          return json({ error: "desktop_not_quiescent", ...this.state() }, 503);
        }
      }
      this.generation = input.generation;
      this.reconciled = true;
      this.taken = input.taken;
      this.confirmed = true;
      return json(this.state());
    });
  }

  private async serializeAction<T>(body: () => Promise<T>): Promise<T> {
    const previous = this.actionTail;
    let release!: () => void;
    this.actionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await body(); }
    finally { release(); }
  }

  private async serializeAdmin<T>(body: () => Promise<T>): Promise<T> {
    const previous = this.adminTail;
    let release!: () => void;
    this.adminTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await body(); }
    finally { release(); }
  }

  async close() {
    this.reconciled = true;
    this.taken = true;
    this.confirmed = false;
    const active = this.active;
    active?.controller.abort();
    if (active) await active.promise;
    await Promise.all([this.actionTail, this.adminTail]);
    await this.driver.quiesce().catch(() => undefined);
    this.journal.close();
  }
}

export function serveDesktopBroker(input: { agentSocket: string; adminSocket: string; journalPath: string; driver: DesktopDriver }) {
  mkdirSync(dirname(input.journalPath), { recursive: true });
  for (const socket of [input.agentSocket, input.adminSocket]) { mkdirSync(dirname(socket), { recursive: true }); rmSync(socket, { force: true }); }
  const broker = new DesktopBroker(input.journalPath, input.driver);
  const agent = Bun.serve({ unix: input.agentSocket, fetch: request => broker.handleAgent(request) });
  chmodSync(input.agentSocket, 0o660);
  const admin = Bun.serve({ unix: input.adminSocket, fetch: request => broker.handleAdmin(request) });
  chmodSync(input.adminSocket, 0o600);
  return { broker, agent, admin, async stop() { agent.stop(true); admin.stop(true); await broker.close(); rmSync(input.agentSocket, { force: true }); rmSync(input.adminSocket, { force: true }); } };
}
