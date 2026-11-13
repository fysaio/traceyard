export function nowIso(): string {
  return new Date().toISOString();
}

export function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function durationMs(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

export function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function hourKey(date = new Date()): string {
  return date.toISOString().slice(0, 13);
}

export function daysAgoIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

export function startOfUtcDay(date = new Date()): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

export function endOfUtcDay(date = new Date()): string {
  const copy = startOfUtcDay(date);
  copy.setUTCDate(copy.getUTCDate() + 1);
  return copy.toISOString();
}
