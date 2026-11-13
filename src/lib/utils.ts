import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(value: string | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function formatRelative(value: string | null): string {
  if (value === null) return "—";
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return "—";
  const future = delta < 0;
  const seconds = Math.max(1, Math.round(Math.abs(delta) / 1000));
  if (seconds < 60) return future ? `in ${seconds}s` : `${seconds}s ago`;
  if (seconds < 3600)
    return future ? `in ${Math.round(seconds / 60)}m` : `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400)
    return future ? `in ${Math.round(seconds / 3600)}h` : `${Math.round(seconds / 3600)}h ago`;
  return future ? `in ${Math.round(seconds / 86_400)}d` : `${Math.round(seconds / 86_400)}d ago`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function formatNumber(value: number | null, digits = 0): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(value === 100 || value === 0 ? 0 : 1)}%`;
}

export function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

export function shortId(value: string): string {
  return value.length <= 14 ? value : value.slice(0, 12);
}
