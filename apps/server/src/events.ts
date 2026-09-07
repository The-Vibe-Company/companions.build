import { db } from "./store";
import { sessionUser } from "./auth";

const CHANNEL = "companion_changed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EventKind = "invalidate" | "resync";
type ListenSubscription = { unlisten(): Promise<void> };
type ListenDatabase = {
  listen(channel: string, onnotify: (payload: string) => void, onlisten?: () => void): Promise<ListenSubscription>;
};

export class EventStreamLimitError extends Error {}

export class CompanionEventHub {
  private startPromise: Promise<void> | null = null;
  private listener: ListenSubscription | null = null;
  private subscribers = new Map<string, Set<{ ownerId: string; deliver: (kind: EventKind) => void }>>();
  private ownerCounts = new Map<string, number>();

  constructor(
    private readonly database: ListenDatabase,
    private readonly limits = { total: 1_000, perOwner: 5 },
  ) {}

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      this.listener = await this.database.listen(
        CHANNEL,
        payload => {
          try {
            if (UUID.test(payload)) this.broadcast(payload, "invalidate");
          } catch {
            // Bun reports listener callback errors as uncaught exceptions. A malformed notification
            // must not take down the API process.
          }
        },
        () => {
          try { this.broadcastAll("resync"); } catch { /* See callback boundary above. */ }
        },
      );
    })().catch(error => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  subscribe(companionId: string, ownerId: string, deliver: (kind: EventKind) => void) {
    const ownerCount = this.ownerCounts.get(ownerId) ?? 0;
    if (this.activeSubscriptions >= this.limits.total || ownerCount >= this.limits.perOwner) {
      throw new EventStreamLimitError("Too many event streams");
    }
    const subscriber = { ownerId, deliver };
    const group = this.subscribers.get(companionId) ?? new Set();
    group.add(subscriber);
    this.subscribers.set(companionId, group);
    this.ownerCounts.set(ownerId, ownerCount + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      group.delete(subscriber);
      if (group.size === 0) this.subscribers.delete(companionId);
      const remaining = (this.ownerCounts.get(ownerId) ?? 1) - 1;
      if (remaining > 0) this.ownerCounts.set(ownerId, remaining);
      else this.ownerCounts.delete(ownerId);
    };
  }

  get activeSubscriptions() {
    let count = 0;
    for (const group of this.subscribers.values()) count += group.size;
    return count;
  }

  private broadcast(companionId: string, kind: EventKind) {
    for (const subscriber of this.subscribers.get(companionId) ?? []) subscriber.deliver(kind);
  }

  private broadcastAll(kind: EventKind) {
    for (const group of this.subscribers.values()) {
      for (const subscriber of group) subscriber.deliver(kind);
    }
  }

  async close() {
    const listener = this.listener;
    this.listener = null;
    this.startPromise = null;
    if (listener) await listener.unlisten();
  }
}

type EventRouteOptions = {
  database?: typeof db;
  hub?: CompanionEventHub;
  authenticate?: () => Promise<string | null>;
  heartbeatMs?: number;
  authRecheckMs?: number;
  maxLifetimeMs?: number;
  flushDelayMs?: number;
};

const globalListenDatabase = db as unknown as ListenDatabase;
export const companionEventHub = new CompanionEventHub(globalListenDatabase);

const eventChunk = (kind: EventKind | "unauthorized") => `event: ${kind}\ndata: {}\n\n`;

export async function handleCompanionEvents(
  request: Request,
  ownerId: string,
  companionId: string,
  options: EventRouteOptions = {},
): Promise<Response> {
  const database = options.database ?? db;
  const hub = options.hub ?? companionEventHub;
  const [owned] = await database.unsafe(
    "SELECT id FROM companions WHERE id=$1 AND owner_id=$2 AND retired_at IS NULL",
    [companionId, ownerId],
  );
  if (!owned) return Response.json({ error: "Companion not found." }, { status: 404 });

  await hub.start();
  const encoder = new TextEncoder();
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const authRecheckMs = options.authRecheckMs ?? 30_000;
  const maxLifetimeMs = options.maxLifetimeMs ?? 10 * 60_000;
  const flushDelayMs = options.flushDelayMs ?? 25;
  const authenticate = options.authenticate ?? (async () => (await sessionUser(request))?.id ?? null);
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let dirty: EventKind | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let authTimer: ReturnType<typeof setInterval> | null = null;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  let authChecking = false;
  let closed = false;

  const enqueue = (value: string) => {
    if (!controller || closed) return false;
    try { controller.enqueue(encoder.encode(value)); return true; }
    catch { cleanup(); return false; }
  };
  const flush = () => {
    flushTimer = null;
    if (!controller || closed || !dirty) return;
    if ((controller.desiredSize ?? 1) <= 0) {
      flushTimer = setTimeout(flush, Math.max(50, flushDelayMs));
      return;
    }
    const kind = dirty;
    dirty = null;
    enqueue(eventChunk(kind));
  };
  const deliver = (kind: EventKind) => {
    if (closed) return;
    dirty = kind === "resync" ? "resync" : (dirty ?? kind);
    if (!flushTimer) flushTimer = setTimeout(flush, flushDelayMs);
  };

  let unsubscribe: (() => void) | null = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    request.signal.removeEventListener("abort", cleanup);
    unsubscribe?.();
    unsubscribe = null;
    if (flushTimer) clearTimeout(flushTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (authTimer) clearInterval(authTimer);
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    try { controller?.close(); } catch { /* The browser may already have disconnected. */ }
    controller = null;
  };

  try { unsubscribe = hub.subscribe(companionId, ownerId, deliver); }
  catch (error) {
    if (error instanceof EventStreamLimitError) {
      return Response.json({ error: "Too many open event streams." }, { status: 429, headers: { "Retry-After": "10" } });
    }
    throw error;
  }

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      enqueue(`retry: 2000\n${eventChunk("resync")}`);
      heartbeatTimer = setInterval(() => {
        if ((controller?.desiredSize ?? 0) > 0) enqueue(": keepalive\n\n");
      }, heartbeatMs);
      authTimer = setInterval(async () => {
        if (authChecking || closed) return;
        authChecking = true;
        try {
          if (await authenticate() !== ownerId) {
            enqueue(eventChunk("unauthorized"));
            cleanup();
          }
        } catch { cleanup(); }
        finally { authChecking = false; }
      }, authRecheckMs);
      lifetimeTimer = setTimeout(cleanup, maxLifetimeMs);
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel: cleanup,
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
