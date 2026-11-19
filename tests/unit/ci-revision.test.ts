import { describe, expect, it } from "vitest";
import { parseCiLink, readCheckoutRevision } from "../../worker/services/ci-revision";
import { flakinessOutcome } from "../../shared/contracts/investigation-execution";

const sha = "a".repeat(40);
const checkout = (repo: string, ref: string) =>
  [
    `2026-11-19T04:00:00.000Z Syncing repository: ${repo}`,
    `2026-11-19T04:00:01.000Z [command]/usr/bin/git fetch origin +${ref}`,
    "2026-11-19T04:00:02.000Z [command]/usr/bin/git log -1 --format=%H",
    `2026-11-19T04:00:03.000Z ${sha}`,
  ].join("\n");

describe("GitHub Actions checkout evidence", () => {
  it("accepts a job link and an attempt only for the connected repository", () => {
    expect(
      parseCiLink(
        "https://github.com/fysaio/example/actions/runs/42/attempts/2/job/43",
        "fysaio/example",
      ),
    ).toEqual({ runId: "42", attempt: "2", jobId: "43" });
    expect(() =>
      parseCiLink("https://github.com/other/example/actions/runs/42", "fysaio/example"),
    ).toThrow("connected repository");
  });
  it("uses the emitted checkout SHA and identifies the pull request merge ref", () => {
    expect(
      readCheckoutRevision(
        checkout("fysaio/example", "refs/remotes/pull/4/merge"),
        "fysaio/example",
      ),
    ).toEqual({ commit: sha, merge: true });
    expect(
      readCheckoutRevision(checkout("fysaio/example", "refs/heads/fix"), "fysaio/example"),
    ).toEqual({ commit: sha, merge: false });
  });
  it("rejects multiple checkouts of the repository or bare commit text", () => {
    expect(
      readCheckoutRevision(
        `${checkout("fysaio/example", "refs/heads/fix")}\n${checkout("fysaio/example", "refs/heads/main")}`,
        "fysaio/example",
      ),
    ).toBeNull();
    expect(readCheckoutRevision(sha, "fysaio/example")).toBeNull();
  });
});

describe("flakiness results", () => {
  function runs(...statuses: ("FAILED" | "SUCCEEDED" | "BLOCKED")[]) {
    return statuses.map((status, index) => ({
      commit: sha,
      attempt: (index % 3) + 1,
      status,
      durationMs: 1,
      message: "",
    }));
  }
  it("reports consistent outcomes as observed counts", () => {
    expect(
      flakinessOutcome(runs("FAILED", "FAILED", "FAILED", "SUCCEEDED", "SUCCEEDED", "SUCCEEDED"))
        .summary,
    ).toBe("failed 3/3, then passed 3/3; no flakiness observed in 3 runs per commit.");
  });
  it("returns Inconclusive on either mixed or incomplete outcomes", () => {
    expect(
      flakinessOutcome(runs("FAILED", "SUCCEEDED", "FAILED", "SUCCEEDED", "SUCCEEDED", "SUCCEEDED"))
        .label,
    ).toBe("Inconclusive");
    expect(
      flakinessOutcome(runs("FAILED", "FAILED", "FAILED", "BLOCKED", "SUCCEEDED", "SUCCEEDED"))
        .label,
    ).toBe("Inconclusive");
  });
});
