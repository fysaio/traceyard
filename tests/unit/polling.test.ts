import { describe, expect, it } from "vitest";

import { RUN_STATUSES, type RunStatus } from "../../shared/domain/status";
import {
  ACTIVE_OVERVIEW_POLL_MS,
  ACTIVE_RUN_POLL_MS,
  overviewPollInterval,
  runPollInterval,
} from "../../src/lib/polling";

const ACTIVE: RunStatus[] = ["QUEUED", "RUNNING", "CANCELLING"];
const TERMINAL = RUN_STATUSES.filter((status) => !ACTIVE.includes(status));

describe("runPollInterval", () => {
  it("polls only while a run can still change", () => {
    for (const status of ACTIVE) {
      expect(runPollInterval(status)).toBe(ACTIVE_RUN_POLL_MS);
    }
    for (const status of TERMINAL) {
      expect(runPollInterval(status)).toBe(false);
    }
  });

  it("never polls before the first load completes", () => {
    expect(runPollInterval(undefined)).toBe(false);
  });

  it("stops immediately at every terminal status", () => {
    expect(TERMINAL).toEqual(["SUCCEEDED", "FAILED", "CANCELLED"]);
  });
});

describe("overviewPollInterval", () => {
  it("does not poll an idle overview", () => {
    expect(overviewPollInterval(undefined)).toBe(false);
    expect(overviewPollInterval({ queued: 0, running: 0, cancelling: 0 })).toBe(false);
  });

  it("polls while any execution is active", () => {
    expect(overviewPollInterval({ queued: 1, running: 0, cancelling: 0 })).toBe(
      ACTIVE_OVERVIEW_POLL_MS,
    );
    expect(overviewPollInterval({ queued: 0, running: 1, cancelling: 0 })).toBe(
      ACTIVE_OVERVIEW_POLL_MS,
    );
    expect(overviewPollInterval({ queued: 0, running: 0, cancelling: 1 })).toBe(
      ACTIVE_OVERVIEW_POLL_MS,
    );
  });

  it("keeps detail polling faster than the overview", () => {
    expect(ACTIVE_RUN_POLL_MS).toBeLessThan(ACTIVE_OVERVIEW_POLL_MS);
  });
});

describe("polling volume budget", () => {
  it("documents the per-tab request ceiling for one active execution", () => {
    // Detail + events each poll once per interval. An active execution costs at
    // most 3,600 requests per hour; a terminal execution costs zero.
    const perHour = (intervalMs: number, queries: number) =>
      Math.ceil((60 * 60 * 1_000) / intervalMs) * queries;

    expect(perHour(ACTIVE_RUN_POLL_MS, 2)).toBe(3_600);
    expect(perHour(ACTIVE_OVERVIEW_POLL_MS, 1)).toBe(900);
    expect(runPollInterval("SUCCEEDED")).toBe(false);
  });

  it("keeps ten idle tabs at zero polling", () => {
    const idleTabs = Array.from({ length: 10 }, () => overviewPollInterval(undefined));
    expect(idleTabs.every((interval) => interval === false)).toBe(true);
  });
});
