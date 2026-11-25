export const EXIT: {
  OK: 0;
  FAILING: 1;
  REVIEW: 2;
  BLOCKED: 3;
  USAGE: 64;
  INTERNAL: 70;
};
export function exitCodeFor(verdict: string): number;
export function isTestInput(path: string): boolean;
interface Run {
  commit: string | null;
  status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  counts: { passed: number; failed: number; skipped: number };
  failures: { name: string; message: string }[];
  message: string;
}
interface Verdict {
  verdict: string;
  summary: string;
  next: string;
}
export function reproVerdict(run: Run, testPath: string, options?: { fromCi?: boolean }): Verdict;
export function checkVerdict(run: Run, testPath: string): Verdict;
export function verifyVerdict(input: {
  baseline: Run;
  candidate: Run;
  testPath: string;
  changedFiles: string[];
}): Verdict & { changedTests: string[] };
export function guardVerdict(input: {
  receipt: {
    id: string;
    verdict: string;
    summary: string;
    test: { path: string; case: string | null };
    baseline: { commit: string | null };
    candidate: { commit: string | null };
    evidenceEnvelope?: {
      claim?: string;
      state?: string;
      revision?: { commit?: string | null };
    };
  } | null;
  intact: boolean;
  head: string | null;
}): Verdict;
