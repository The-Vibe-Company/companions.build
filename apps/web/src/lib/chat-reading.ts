import type { ChatEntry } from "@/api";
export interface ReadingPosition { bottom: boolean; id?: string; cursor?: string; offset?: number; entry?: ChatEntry }
const prefix = 'companions:chat-reading:';
const memory = new Map<string, ReadingPosition>();
export const readingKey = (accountId: string, companionId: string) => `${prefix}${accountId}:${companionId}`;
export function readPosition(key: string): ReadingPosition {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const value = JSON.parse(raw);
      if (value?.bottom === true) return { bottom: true };
      if (value?.bottom === false && typeof value.id === 'string' && typeof value.cursor === 'string' && value.cursor.length <= 512 && Number.isFinite(value.offset)) {
        const entry = value.entry;
        const validEntry = entry && typeof entry.id === 'string' && typeof entry.cursor === 'string' && typeof entry.runId === 'string'
          && typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt)) && Number.isInteger(entry.sequence)
          && ['message', 'question', 'routine', 'thinking'].includes(entry.kind);
        return { bottom: false, id: value.id, cursor: value.cursor, offset: value.offset,
          ...(validEntry ? { entry: { id: entry.id, cursor: entry.cursor, runId: entry.runId, createdAt: entry.createdAt, sequence: entry.sequence, kind: entry.kind } } : {}),
        };
      }
    }
  } catch { /* Private browsing and storage quotas must not prevent reading. */ }
  return memory.get(key) ?? { bottom: true };
}
export function savePosition(key: string, position: ReadingPosition) {
  memory.set(key, position);
  try { sessionStorage.setItem(key, JSON.stringify(position)); } catch { /* In-memory fallback. */ }
}
export function clearReadingPositions() {
  memory.clear();
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key); } catch { /* Storage can be unavailable. */ }
}
