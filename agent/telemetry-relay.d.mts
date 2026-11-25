export declare const RELAY_MAX_BODY_BYTES: number;
export declare const LOCAL_ENV_FILE_KEYS: readonly string[];
export declare function startTelemetryRelay(options: {
  target: string;
  credential: () => Promise<string>;
  fetch?: typeof fetch;
}): Promise<{ endpoint: string; origin: string; close: () => Promise<void> }>;
export declare function untrustedEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string>;
