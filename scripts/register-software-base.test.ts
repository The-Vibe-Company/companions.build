import { expect, test } from "bun:test";
import { completedSnapshotJournal } from "./register-software-base";

test("software base registration accepts only a completed attempt after any quota rejection", () => {
  expect(completedSnapshotJournal({ snapshotRequestedAt: "2026-09-07T10:00:00.000Z", completedAt: "2026-09-07T10:01:00.000Z" })).toBe(true);
  expect(completedSnapshotJournal({ snapshotRejectedAt: "2026-09-07T09:00:00.000Z", snapshotRequestedAt: "2026-09-07T10:00:00.000Z", completedAt: "2026-09-07T10:01:00.000Z" })).toBe(true);
  expect(completedSnapshotJournal({ snapshotRejectedAt: "2026-09-07T10:00:30.000Z", snapshotRequestedAt: "2026-09-07T10:00:00.000Z", completedAt: "2026-09-07T10:01:00.000Z" })).toBe(false);
  expect(completedSnapshotJournal({ snapshotRequestedAt: "2026-09-07T10:00:00.000Z" })).toBe(false);
});
