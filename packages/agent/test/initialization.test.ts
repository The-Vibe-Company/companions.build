import { expect, test } from "bun:test";
import { guardedInitialization } from "../src/pi-executor";

test("a cancelled late initializer is disposed and cannot return a prompt-capable session", async () => {
  let resolve!: (value: { dispose(): void }) => void;
  let disposed = false;
  const work = new Promise<{ dispose(): void }>(done => { resolve = done; });
  const controller = new AbortController();
  const guarded = guardedInitialization(work, controller.signal, 1_000);
  controller.abort();
  await expect(guarded).rejects.toThrow("RUN_CANCELLED");
  resolve({ dispose: () => { disposed = true; } });
  await Bun.sleep(0);
  expect(disposed).toBe(true);
});

test("a timed-out late initializer is disposed", async () => {
  let resolve!: (value: { dispose(): void }) => void;
  let disposed = false;
  const work = new Promise<{ dispose(): void }>(done => { resolve = done; });
  await expect(guardedInitialization(work, new AbortController().signal, 1)).rejects.toThrow("INITIALIZATION_TIMEOUT");
  resolve({ dispose: () => { disposed = true; } });
  await Bun.sleep(0);
  expect(disposed).toBe(true);
});
