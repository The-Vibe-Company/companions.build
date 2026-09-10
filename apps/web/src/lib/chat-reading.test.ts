import { afterEach, expect, it, vi } from 'vitest';
import { clearReadingPositions, readPosition, readingKey, savePosition } from './chat-reading';
afterEach(() => { vi.restoreAllMocks(); clearReadingPositions(); });
it('isolates accounts and Companions and removes persisted positions on sign-out', () => {
  const key = readingKey('alice', 'one');
  savePosition(key, { bottom:false, id:'m', cursor:'cursor', offset:-12 });
  expect(readPosition(key)).toMatchObject({ bottom:false, offset:-12 });
  expect(readPosition(readingKey('bob','one'))).toEqual({bottom:true});
  expect(readPosition(readingKey('alice','two'))).toEqual({bottom:true});
  clearReadingPositions(); expect(readPosition(key)).toEqual({bottom:true});
});
it('tolerates corrupt and unavailable session storage', () => {
  const key = readingKey('alice','one');
  sessionStorage.setItem(key,'{broken'); expect(readPosition(key)).toEqual({bottom:true});
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
  vi.spyOn(Storage.prototype,'getItem').mockImplementation(() => { throw new Error('Unavailable'); });
  savePosition(key,{bottom:false,id:'m',cursor:'cursor',offset:3});
  expect(readPosition(key)).toMatchObject({bottom:false,id:'m',offset:3});
});

it('ignores malformed optional sort metadata instead of crashing restoration', () => {
  const key=readingKey('alice','one');
  sessionStorage.setItem(key,JSON.stringify({bottom:false,id:'m',cursor:'cursor',offset:2,entry:{createdAt:null},content:'not a stored field'}));
  expect(readPosition(key)).toEqual({bottom:false,id:'m',cursor:'cursor',offset:2});
});
