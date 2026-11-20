import { it, expect } from "vitest";
import { env } from "cloudflare:workers";
it("uses test-only service settings without operator credentials, runner pins or dotenv variables", () => {
  const settings = env as unknown as Record<string, unknown>;
  expect(settings.APP_VERSION).toBe("0.1.0");
  expect(settings.SOURCE_SCAN_FILE_LIMIT).toBe("16");
  expect(settings.PUBLIC_APP_ORIGIN).toBe("https://traceyard.test");
  expect(settings.GITHUB_CLIENT_ID).toBe("traceyard-test-client");
  for (const name of [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_WEBHOOK_SECRET",
    "TRACEYARD_RUNNER_REF",
    "OPERATOR_ONLY_SENTINEL",
    "OPERATOR_DOT_ENV_SENTINEL",
  ]) {
    expect(name in env, `${name} must not be loaded from the operator environment`).toBe(false);
  }
  expect(env.DB).toBeDefined();
  expect(env.REPOSITORY_DISCOVERY).toBeDefined();
});
