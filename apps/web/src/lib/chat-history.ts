import { api, ApiError, type ChatEntry, type ChatPage, type ChatQuery, type CompanionDetail } from '@/api';
import type { ReadingPosition } from './chat-reading';

// ISO UTC strings retain PostgreSQL microseconds; Date.parse would discard them.
const timeKey = (value: string) => value.replace(/\.(\d+)Z$/, (_, fraction: string) => `.${fraction.padEnd(6, '0')}Z`);
export function compareEntries(a: ChatEntry, b: ChatEntry) {
  return timeKey(a.createdAt).localeCompare(timeKey(b.createdAt)) || a.sequence - b.sequence || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
}
function mergeRows<T>(rows: T[], key: (value: T) => string): T[] {
  return [...new Map(rows.map(row => [key(row), row])).values()];
}
export function mergePages(pages: ChatPage[]): ChatPage {
  const entries = mergeRows(pages.flatMap(page => page.entries), entry => entry.id).sort(compareEntries);
  return {
    entries,
    messages: mergeRows(pages.flatMap(page => page.messages), row => row.id),
    runs: mergeRows(pages.flatMap(page => page.runs), row => row.id),
    questions: mergeRows(pages.flatMap(page => page.questions), row => row.id),
    files: mergeRows(pages.flatMap(page => page.files), row => `${row.runId}:${row.id}`),
    specialists: mergeRows(pages.flatMap(page => page.specialists), row => row.delegationId),
    beforeCursor: pages[0]?.beforeCursor ?? null,
    afterCursor: pages.at(-1)?.afterCursor ?? null,
    nextCursor: null,
  };
}
interface Window { lower: ChatEntry; upper: ChatEntry; page: ChatPage }
function windowFor(page: ChatPage): Window | null {
  return page.entries.length ? { lower: page.entries[0], upper: page.entries.at(-1)!, page } : null;
}
function coalesce(windows: Window[]): Window[] {
  const result: Window[] = [];
  for (const window of [...windows].sort((a, b) => compareEntries(a.lower, b.lower))) {
    const prior = result.at(-1);
    if (prior && compareEntries(window.lower, prior.upper) <= 0) {
      const upper = compareEntries(window.upper, prior.upper) > 0 ? window.upper : prior.upper;
      const page = mergePages([prior.page, window.page]);
      page.afterCursor = upper === window.upper ? window.page.afterCursor : prior.page.afterCursor;
      result[result.length - 1] = { lower: prior.lower, upper, page };
    } else result.push(window);
  }
  return result;
}
function stabilize<T extends { id: string }>(oldRows: T[], rows: T[]) {
  const old = new Map(oldRows.map(row => [row.id, row]));
  return rows.map(row => {
    const prior = old.get(row.id);
    return prior && JSON.stringify(prior) === JSON.stringify(row) ? prior : row;
  });
}
export interface HistoryState {
  detail: CompanionDetail;
  loading: boolean;
  restoring: boolean;
  resetReading?: boolean;
  error: string;
  gaps: Array<{ beforeId: string; after: string }>;
  older: string | null;
}
type FetchPage = (id: string, query: ChatQuery, signal?: AbortSignal) => Promise<ChatPage>;

/** Serializes page reads and snapshot reconciliation. Notifications remain invalidations, not a log. */
export class ChatHistory {
  private windows: Window[] = [];
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private pending = new Set<string>();
  private initialized = false;
  private failed: { key: string; action: () => Promise<void> } | null = null;
  retry = () => this.failed ? this.run(this.failed.key, this.failed.action) : this.queue;
  private snapshot: CompanionDetail;
  private observedQuestions = new Map<string, NonNullable<CompanionDetail['questions']>[number]>();
  private observedRoutines = new Map<string, CompanionDetail['runs'][number]>();
  private rememberLive(snapshot: CompanionDetail) {
    const loaded = new Set(this.windows.flatMap(window => window.page.entries.map(entry => entry.id)));
    for (const question of snapshot.live?.questions ?? []) if (question.cursor && !loaded.has(question.id)) this.observedQuestions.set(question.id, question);
    for (const run of snapshot.live?.runs ?? []) if (run.source === 'routine' && run.cursor && !loaded.has(`routine-${run.id}`)) this.observedRoutines.set(run.id, run);
    for (const id of this.observedQuestions.keys()) if (loaded.has(id)) this.observedQuestions.delete(id);
    for (const id of this.observedRoutines.keys()) if (loaded.has(`routine-${id}`)) this.observedRoutines.delete(id);
  }
  private async settleObserved(snapshot: CompanionDetail) {
    const liveQuestions = new Set(snapshot.live?.questions.map(question => question.id));
    for (const [id, question] of this.observedQuestions) {
      if (liveQuestions.has(id) || question.answer != null || !['queued', 'preparing', 'running', 'needs_input'].includes(question.runStatus ?? 'running')) continue;
      const page = await this.page({ around: question.cursor!, limit: 1 });
      const settled = page.questions.find(item => item.id === id);
      if (settled) this.observedQuestions.set(id, { ...settled, cursor: question.cursor });
      else this.observedQuestions.delete(id);
    }
    const liveRuns = new Set(snapshot.live?.runs.map(run => run.id));
    for (const [id, run] of this.observedRoutines) {
      if (liveRuns.has(id) || !['queued', 'preparing', 'running', 'needs_input'].includes(run.status)) continue;
      const page = await this.page({ around: run.cursor!, limit: 1 });
      const settled = page.entries.some(entry => entry.id === `routine-${id}`) ? page.runs.find(item => item.id === id) : undefined;
      if (settled) this.observedRoutines.set(id, { ...settled, cursor: run.cursor });
      else this.observedRoutines.delete(id); // A published message replaces the trace.
    }
  }
  state: HistoryState;
  constructor(snapshot: CompanionDetail, private fetchPage: FetchPage = api.getChatPage) {
    this.snapshot = snapshot;
    this.state = { detail: snapshot, loading: false, restoring: Boolean(snapshot.chat), error: '', gaps: [], older: snapshot.chat?.beforeCursor ?? null };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  dispose() { this.abort.abort(); this.listeners.clear(); }
  private publish(patch: Partial<HistoryState>) {
    if (this.abort.signal.aborted) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private run(key: string, action: () => Promise<void>) {
    if (this.pending.has(key) || this.abort.signal.aborted) return this.queue;
    this.pending.add(key);
    this.queue = this.queue.then(async () => {
      if (this.abort.signal.aborted) return;
      this.publish({ loading: true, error: '' });
      this.failed = null;
      try { await action(); }
      catch (error) { this.failed = { key, action }; if (!this.abort.signal.aborted) this.publish({ error: error instanceof Error ? error.message : 'Could not load conversation.' }); }
      finally { this.pending.delete(key); this.publish({ loading: false }); }
    });
    return this.queue;
  }
  private page(query: ChatQuery) { return this.fetchPage(this.snapshot.companion.id, query, this.abort.signal); }
  private commit() {
    if (this.abort.signal.aborted) return;
    const page = mergePages(this.windows.map(window => window.page));
    const old = this.state.detail;
    const runs = mergeRows([...this.observedRoutines.values(), ...page.runs, ...(this.snapshot.live?.runs ?? [])], run => run.id);
    const questions = mergeRows([...this.observedQuestions.values(), ...page.questions, ...(this.snapshot.live?.questions ?? [])], question => question.id);
    const detail = {
      ...this.snapshot, chat: page, retainedRuns: [...this.observedRoutines.values()],
      messages: stabilize(old.messages, page.messages),
      runs: stabilize(old.runs, runs),
      questions: stabilize(old.questions ?? [], questions),
      files: page.files, specialists: page.specialists,
    };
    this.publish({ detail, restoring: false, older: this.windows[0]?.page.beforeCursor ?? null,
      gaps: this.windows.slice(1).map((window, index) => ({ beforeId: window.page.entries[0]?.id ?? window.lower.id, after: this.windows[index].upper.cursor })),
    });
  }
  initialize(position: ReadingPosition) {
    return this.run('initialize', async () => {
      if (this.initialized) return;
      const recent = this.snapshot.chat;
      if (!recent) { this.initialized = true; this.publish({ restoring: false }); return; }
      const windows: Window[] = [];
      if (!position.bottom && position.cursor && !recent.entries.some(entry => entry.id === position.id)) {
        try {
          const around = windowFor(await this.page({ around: position.cursor }));
          if (around) windows.push(around);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 400) throw error;
          // Invalid/versioned-away local state must not make a valid conversation inaccessible.
          this.publish({ resetReading: true });
        }
      }
      const latest = windowFor(recent);
      if (latest) windows.push(latest);
      this.windows = coalesce(windows);
      this.rememberLive(this.snapshot);
      this.initialized = true;
      this.commit();
    });
  }
  refresh(snapshot: CompanionDetail) {
    return this.run(`refresh:${++this.refreshId}`, async () => {
      if (!this.initialized || !snapshot.chat) { this.snapshot = snapshot; this.publish({ detail: snapshot }); return; }
      await this.settleObserved(snapshot);
      const refreshed: Window[] = [];
      for (const window of this.windows) {
        const pages: ChatPage[] = [];
        let after: string | undefined;
        do {
          const page = await this.page({ from: window.lower.cursor, through: window.upper.cursor, ...(after ? { after } : {}) });
          pages.push(page);
          if (page.nextCursor === after) throw new Error('Conversation pagination did not advance. Please retry.');
          after = page.nextCursor ?? undefined;
        } while (after);
        refreshed.push({ ...window, page: mergePages(pages) });
      }
      const latest = windowFor(snapshot.chat);
      this.snapshot = snapshot;
      this.windows = coalesce([...refreshed, ...(latest ? [latest] : [])]);
      this.rememberLive(snapshot);
      this.commit();
    });
  }
  private refreshId = 0;
  older = () => this.run('older', async () => {
    const window = this.windows[0];
    if (!window?.page.beforeCursor) return;
    const page = await this.page({ before: window.page.beforeCursor });
    const older = windowFor(page);
    if (older) this.windows[0] = { lower: older.lower, upper: window.upper, page: mergePages([page, window.page]) };
    else window.page = { ...window.page, beforeCursor: null };
    this.commit();
  });
  fillGap = (after: string) => this.run(`gap:${after}`, async () => {
    const index = this.windows.findIndex(window => window.upper.cursor === after);
    if (index < 0) return;
    const window = this.windows[index];
    const page = await this.page({ after });
    const newer = windowFor(page);
    if (newer) this.windows[index] = { lower: window.lower, upper: newer.upper, page: mergePages([window.page, page]) };
    this.windows = coalesce(this.windows);
    this.commit();
  });
}
