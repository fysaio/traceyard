import { expect, it } from "vitest";
import { checkDisplayStatus } from "../../shared/repository/check-status";
import type { RepositoryJob } from "../../shared/repository/contracts";

it("distinguishes overdue updates from confirmed running and terminal states", () => {
  const now = Date.now();
  const job = {
    status: "RUNNING",
    updated_at: new Date(now - 20 * 60000).toISOString(),
  } as RepositoryJob;
  expect(checkDisplayStatus(job, now)).toBe("STALE");
  const synced = {
    ...job,
    events_json: JSON.stringify([
      { phase: "sync", status: "CONFIRMED_RUNNING", at: new Date(now).toISOString() },
    ]),
  };
  expect(checkDisplayStatus(synced, now)).toBe("RUNNING");
  expect(checkDisplayStatus(synced, now + 90000)).toBe("STALE");
  expect(checkDisplayStatus({ ...job, updated_at: new Date(now - 1000).toISOString() }, now)).toBe(
    "RUNNING",
  );
  for (const status of ["SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"])
    expect(checkDisplayStatus({ ...job, status }, now)).toBe(status);
});
