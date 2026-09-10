import { ArrowDown } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatEntry } from '@/api';
import { compareEntries } from '@/lib/chat-history';
import { readPosition, savePosition, type ReadingPosition } from '@/lib/chat-reading';
import { Button } from './ui/button';
import './ChatViewport.css';

export function ChatViewport({ storageKey, entries, ready, resetReading, loading, older, onOlder, error, onRetry, latestId, children }: {
  resetReading?: boolean; storageKey: string; entries: ChatEntry[]; ready: boolean; loading: boolean; older: boolean;
  onOlder: () => void; error: string; onRetry: () => void; latestId?: string; children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const position = useRef<ReadingPosition>(resetReading ? { bottom: true } : readPosition(storageKey));
  const restored = useRef(false);
  const programmaticTop = useRef<number | null>(null);
  const [following, setFollowing] = useState(position.current.bottom);
  const [newMessage, setNewMessage] = useState(false);
  const previousLatest = useRef(latestId);
  const entryMap = useRef(new Map<string, ChatEntry>());
  entryMap.current = new Map(entries.map(entry => [entry.id, entry]));
  const visible = () => Boolean(viewport.current?.clientHeight);
  const capture = useCallback(() => {
    const element = viewport.current;
    if (!element || !restored.current || !visible()) return;
    const bottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 32;
    const top = element.getBoundingClientRect().top;
    const anchors = Array.from(element.querySelectorAll<HTMLElement>('[data-chat-id]'));
    const anchor = anchors.find(node => node.getBoundingClientRect().bottom > top + 1) ?? anchors.at(-1);
    const entry = anchor ? entryMap.current.get(anchor.dataset.chatId!) : undefined;
    // Retain the last durable anchor while looking at a transient status or empty page.
    position.current = bottom ? { bottom: true } : entry && anchor ? {
      bottom: false, id: entry.id, cursor: entry.cursor, offset: anchor.getBoundingClientRect().top - top, entry,
    } : { ...position.current, bottom: false };
    setFollowing(bottom);
    if (bottom) setNewMessage(false);
    savePosition(storageKey, position.current);
  }, [storageKey]);
  const restore = useCallback(() => {
    const element = viewport.current;
    if (!element || !ready || !visible()) return;
    const saved = position.current;
    if (saved.bottom) element.scrollTop = element.scrollHeight;
    else {
      const anchors = Array.from(element.querySelectorAll<HTMLElement>('[data-chat-id]'));
      let anchor = anchors.find(node => node.dataset.chatId === saved.id);
      if (!anchor) {
        const nearest = saved.entry ? [...entryMap.current.values()].sort(compareEntries).find(entry => compareEntries(entry, saved.entry!) >= 0) : undefined;
        anchor = anchors.find(node => node.dataset.chatId === nearest?.id) ?? anchors.at(-1);
      }
      if (anchor) {
        element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - (saved.offset ?? 0);
        const entry = entryMap.current.get(anchor.dataset.chatId!);
        if (entry && saved.id !== entry.id) {
          position.current = { ...saved, id: entry.id, cursor: entry.cursor, entry };
          savePosition(storageKey, position.current);
        }
      }
    }
    programmaticTop.current = element.scrollTop;
    restored.current = true;
  }, [ready, storageKey]);
  useLayoutEffect(() => {
    restore();
    if (latestId !== previousLatest.current && !position.current.bottom) setNewMessage(true);
    previousLatest.current = latestId;
  });
  useEffect(() => {
    if (ready && !loading && !error && older && !position.current.bottom && visible() && viewport.current!.scrollTop < 160) onOlder();
  }, [ready, loading, error, older, onOlder]);
  useLayoutEffect(() => {
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(restore) : null;
    if (content.current) observer?.observe(content.current);
    if (viewport.current) observer?.observe(viewport.current);
    const save = () => { if (restored.current) savePosition(storageKey, position.current); };
    window.addEventListener('pagehide', save);
    return () => { save(); observer?.disconnect(); window.removeEventListener('pagehide', save); };
  }, [restore, storageKey]);
  const latest = () => {
    position.current = { bottom: true };
    setFollowing(true); setNewMessage(false);
    restore(); savePosition(storageKey, position.current);
  };
  return <div className="chat-viewport-shell conversation">
    <div ref={viewport} className="chat-viewport" role="log" aria-label="Conversation" aria-busy={!ready} onScroll={() => {
      if (!ready || !visible()) return;
      const element = viewport.current!;
      if (programmaticTop.current !== null && Math.abs(element.scrollTop - programmaticTop.current) < 1) { programmaticTop.current = null; return; }
      programmaticTop.current = null;
      capture();
      if (element.scrollTop < 160 && older && !loading && !error) onOlder();
    }}>
      <div ref={content} className="conversation-content chat-history-content" style={{ visibility: ready ? 'visible' : 'hidden' }}>
        {older && <div className="chat-page-control"><Button variant="ghost" disabled={loading} onClick={onOlder}>{loading ? 'Loading earlier messages…' : 'Load earlier messages'}</Button></div>}
        {error && <div className="chat-page-control" role="alert"><p>{error}</p><Button variant="outline" onClick={onRetry} disabled={loading}>Try again</Button></div>}
        {children}
      </div>
    </div>
    {!ready && <div className="chat-restore-status" role="status">Restoring conversation…{error && <><p>{error}</p><Button onClick={onRetry}>Try again</Button></>}</div>}
    {ready && !following && <Button className="chat-latest" variant="outline" onClick={latest} aria-label={newMessage ? 'New message · Scroll to latest' : 'Scroll to latest message'}><ArrowDown/>{newMessage && 'New message'}</Button>}
  </div>;
}
