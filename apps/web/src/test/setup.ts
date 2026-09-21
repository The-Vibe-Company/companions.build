import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;

// Some JS runtimes used for focused checks expose jsdom's sessionStorage but not
// localStorage. The bare global is what the components persist to, so back it
// with an in-memory Storage when the runtime leaves it undefined.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() { return store.size; },
    clear: () => { store.clear(); },
    getItem: key => (store.has(String(key)) ? store.get(String(key))! : null),
    key: index => [...store.keys()][index] ?? null,
    removeItem: key => { store.delete(String(key)); },
    setItem: (key, value) => { store.set(String(key), String(value)); },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
}

afterEach(() => cleanup());
