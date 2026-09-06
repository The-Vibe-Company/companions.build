import { describe, expect, test } from "bun:test";
import { FilterExecutionError, runFilter } from "../index";

describe("isolated trigger filters", () => {
  test("evaluates payloads and predefined provider responses", async () => {
    expect(await runFilter({
      code: `function shouldTrigger(payload,responses) { return payload.action === "failed" && responses.issue.open === true }`,
      payload: { action: "failed" }, responses: { issue: { open: true } },
    })).toBe(true);
    expect(await runFilter({ code: `function shouldTrigger() { return false }`, payload: {} })).toBe(false);
  });

  test("cannot load host modules or access host files", async () => {
    await expect(runFilter({
      code: `function shouldTrigger() { return require("node:fs").existsSync("/etc/passwd") }`, payload: {},
    })).rejects.toBeInstanceOf(FilterExecutionError);
    await expect(runFilter({
      code: `function shouldTrigger() { return ({}).constructor.constructor("return process")().version.length > 0 }`, payload: {},
    })).rejects.toBeInstanceOf(FilterExecutionError);
  });

  test("terminates malicious infinite filters", async () => {
    const started = Date.now();
    await expect(runFilter({ code: `function shouldTrigger() { while(true) {} }`, payload: {} }))
      .rejects.toBeInstanceOf(FilterExecutionError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
