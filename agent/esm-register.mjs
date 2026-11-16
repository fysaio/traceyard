import { createRequire, register } from "node:module";

// Node uses a separate loader for ES modules. Register the instrumentation hook
// before importing application modules, including TypeScript loaded with tsx.
const require = createRequire(import.meta.url);
register(require.resolve("@opentelemetry/instrumentation/hook.mjs"), import.meta.url);
