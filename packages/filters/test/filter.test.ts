import { describe, expect, test } from "bun:test";
import { FilterExecutionError, runFilter } from "../index";

describe("isolated trigger filters", () => {
  test("evaluates payloads and predefined provider responses with strict booleans", async () => {
    expect(await runFilter({
      code: `function shouldTrigger(payload,responses) { return payload.action === "failed" && responses.issue.open === true }`,
      payload: { action: "failed" }, responses: { issue: { open: true } },
    })).toBe(true);
    expect(await runFilter({ code: `function shouldTrigger() { return false }`, payload: {} })).toBe(false);
    await expect(runFilter({ code: `function shouldTrigger() { return 1 }`, payload: {} }))
      .rejects.toBeInstanceOf(FilterExecutionError);
  });

  test("has no host capabilities, module loader, or mutable input bridge", async () => {
    for (const code of [
      `function shouldTrigger() { return require("node:fs").existsSync("/etc/passwd") }`,
      `function shouldTrigger() { return ({}).constructor.constructor("return process")().version.length > 0 }`,
      `function shouldTrigger(payload) { payload.action = "changed"; return true }`,
    ]) {
      await expect(runFilter({ code, payload: { action: "original" } })).rejects.toBeInstanceOf(FilterExecutionError);
    }
    expect(await runFilter({
      code: `function shouldTrigger() { return Function("return typeof Bun + typeof fetch + typeof Deno")() === "undefinedundefinedundefined" }`,
      payload: {},
    })).toBe(true);
    await expect(runFilter({ code: `import value from "node:fs"; function shouldTrigger() { return !!value }`, payload: {} }))
      .rejects.toBeInstanceOf(FilterExecutionError);
  });

  test("terminates CPU and memory exhaustion within the host bound", async () => {
    const started = Date.now();
    await expect(runFilter({ code: `function shouldTrigger() { while(true) {} }`, payload: {} }))
      .rejects.toBeInstanceOf(FilterExecutionError);
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(runFilter({ code: `function shouldTrigger() { return new ArrayBuffer(64 * 1024 * 1024).byteLength > 0 }`, payload: {} }))
      .rejects.toBeInstanceOf(FilterExecutionError);
  });

  test("uses a fresh guest runtime for every concurrent evaluation", async () => {
    const [polluted, clean, ordinary] = await Promise.all([
      runFilter({ code: `function shouldTrigger() { Object.prototype.leaked = true; return true }`, payload: {} }),
      runFilter({ code: `function shouldTrigger() { return ({}).leaked === undefined }`, payload: {} }),
      runFilter({ code: `globalThis.filterState = 41; function shouldTrigger() { return ++filterState === 42 }`, payload: {} }),
    ]);
    expect([polluted, clean, ordinary]).toEqual([true, true, true]);
    expect(await runFilter({ code: `function shouldTrigger() { return typeof filterState === "undefined" }`, payload: {} })).toBe(true);
  });

  test("does not expose guest errors across the boundary", async () => {
    try {
      await runFilter({ code: `function shouldTrigger() { throw new Error("private provider value") }`, payload: {} });
      throw new Error("expected the filter to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(FilterExecutionError);
      expect((error as Error).message).toBe("The trigger filter could not be evaluated.");
      expect((error as Error).message).not.toContain("private provider value");
    }
  });
});
