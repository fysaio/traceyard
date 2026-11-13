import { Badge } from "./ui/badge";
import type { RunStatus, StepStatus, AttemptStatus } from "../../shared/domain/status";

type AnyStatus = RunStatus | StepStatus | AttemptStatus | "ABANDONED";

const TONES: Record<AnyStatus, "neutral" | "success" | "danger" | "warning" | "info" | "accent"> = {
  QUEUED: "neutral",
  RUNNING: "info",
  SUCCEEDED: "success",
  FAILED: "danger",
  CANCELLING: "warning",
  CANCELLED: "neutral",
  PENDING: "neutral",
  SKIPPED: "neutral",
  ABANDONED: "warning",
};

export function StatusBadge({ status }: { status: AnyStatus }) {
  return (
    <Badge tone={TONES[status] ?? "neutral"} className="gap-1.5">
      {status === "RUNNING" ? (
        <span className="live-dot inline-block size-1.5 rounded-full bg-sky-300" />
      ) : null}
      {status}
    </Badge>
  );
}
