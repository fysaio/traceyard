declare global {
  interface Env {
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    PUBLIC_APP_ORIGIN?: string;
    BUILD_REVISION?: string;
  }
}

export interface AppConfig {
  version: string;
}

export function getConfig(env: Env): AppConfig {
  return {
    version: env.APP_VERSION,
  };
}
