export interface ActionsLink {
  repository: string;
  runId: string;
  attempt?: string;
  jobId?: string;
}
export function parseActionsUrl(value: string): ActionsLink | null;
export function readCheckoutRevision(
  log: string,
  repository: string,
): { commit: string; merge: boolean } | null;
export function failingTestsFromLog(log: string): string[];
