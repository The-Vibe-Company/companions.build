import { expect, test } from "bun:test";
import { db, assertMigrated, migrate, migrationFingerprint } from "../src/store";

test("fresh concurrent service startup applies DDL once before ordinary work", async () => {
  const children = Array.from({ length: 3 }, () => Bun.spawn([
    process.execPath,
    "apps/server/test/fixtures/migrate-startup-process.ts",
  ], {
    env: { ...process.env, COMPANIONS_SCHEMA_PREPARED: "0" },
    stdout: "pipe",
    stderr: "pipe",
  }));
  const results = await Promise.all(children.map(async child => {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout.trim()) as { applied: boolean; fingerprint: string };
  }));
  expect(results.filter(result => result.applied)).toHaveLength(1);
  expect(new Set(results.map(result => result.fingerprint)).size).toBe(1);
  expect(await assertMigrated()).toBe(await migrationFingerprint());
  const [state] = await db`SELECT count(*)::int AS count FROM companions_schema_state`;
  expect(state.count).toBe(1);
});

test("an orchestrated service refuses a missing or stale migration fingerprint", async () => {
  const expected = await migrationFingerprint();
  await db`UPDATE companions_schema_state SET fingerprint='stale' WHERE singleton=true`;
  await expect(assertMigrated()).rejects.toThrow("Database schema is stale");
  const repaired = await migrate();
  expect(repaired).toEqual({ applied: true, fingerprint: expected });
  expect(await assertMigrated()).toBe(expected);
});
