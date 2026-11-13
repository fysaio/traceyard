import { Badge } from "./ui/badge";
import { Icon } from "./ui/icon";
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
      <Icon
        name={
          status === "SUCCEEDED"
            ? "check-circle"
            : status === "FAILED"
              ? "x-circle"
              : status === "RUNNING"
                ? "loader"
                : status === "CANCELLED" || status === "CANCELLING"
                  ? "ban"
                  : "circle"
        }
        className={status === "RUNNING" ? "animate-spin" : ""}
      />
      {status}
    </Badge>
  );
}
