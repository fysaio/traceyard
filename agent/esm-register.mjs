import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";

// Vitest loads application modules through its own transformer. A second ESM
// loader instruments the test tool's dependency graph and makes every fork slow,
// without observing those transformed application imports. The CommonJS preload
// still records actual Node HTTP activity in these workers.
const entry = (process.argv[1] ?? "").replaceAll("\\", "/");
const vitest =
  /\/node_modules\/vitest\//.test(entry) ||
  (process.env.VITEST === "true" && /\/node_modules\/(?:tinypool|vite-node)\//.test(entry));
if (!vitest) {
  // Ordinary applications, including tsx, retain the full ESM instrumentation.
  const require = createRequire(import.meta.url);
  // require.resolve returns a filesystem path; register expects a URL specifier on Windows.
  register(
    pathToFileURL(require.resolve("@opentelemetry/instrumentation/hook.mjs")).href,
    import.meta.url,
  );
}
