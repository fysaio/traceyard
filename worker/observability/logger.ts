type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

/**
 * Platform telemetry is emitted as one JSON object per line. It is deliberately
 * separate from Traceyard's product event log (D1 `execution_events`): these
 * lines describe the health of Traceyard itself.
 *
 * Do not add raw execution inputs, cookies, tokens or credentials to log
 * fields. Identifiers are sufficient for correlation.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: "traceyard",
    event,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  log("error", event, {
    ...fields,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage:
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  });
}
