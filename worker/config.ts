declare global {
  interface Env {
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    PUBLIC_APP_ORIGIN?: string;
  }
}

export interface AppConfig {
  version: string;
  sandbox: {
    dailyRunLimit: number;
    sessionHourlyLimit: number;
    sessionDailyLimit: number;
    globalConcurrencyLimit: number;
  };
  retentionDays: number;
}

function intFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function getConfig(env: Env): AppConfig {
  return {
    version: env.APP_VERSION,
    sandbox: {
      dailyRunLimit: intFrom(env.SANDBOX_DAILY_RUN_LIMIT, 100, 1, 10_000),
      sessionHourlyLimit: intFrom(env.SANDBOX_SESSION_HOURLY_LIMIT, 6, 1, 1_000),
      sessionDailyLimit: intFrom(env.SANDBOX_SESSION_DAILY_LIMIT, 20, 1, 1_000),
      globalConcurrencyLimit: intFrom(env.SANDBOX_GLOBAL_CONCURRENCY_LIMIT, 8, 1, 100),
    },
    retentionDays: intFrom(env.RUN_RETENTION_DAYS, 30, 1, 365),
  };
}
