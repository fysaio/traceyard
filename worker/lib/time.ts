export function nowIso(): string {
  return new Date().toISOString();
}

export function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}
