import type { RepositoryJob } from "./contracts";

export const CHECK_STALE_MS = 15 * 60 * 1000;
export function checkDisplayStatus(job: RepositoryJob, now = Date.now()) {
  const lastSync = (
    JSON.parse(job.events_json ?? "[]") as { phase: string; status: string; at: string }[]
  )
    .filter((event) => event.phase === "sync")
    .at(-1);
  const confirmed =
    lastSync?.status === "CONFIRMED_RUNNING" && now - Date.parse(lastSync.at) < 90000;
  return ["RUNNING", "QUEUED"].includes(job.status) &&
    now - Date.parse(job.updated_at) >= CHECK_STALE_MS
    ? confirmed
      ? "RUNNING"
      : "STALE"
    : job.status;
}
