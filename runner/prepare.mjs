// Trusted bootstrap: the application repository does not control this package.
import { cp } from "node:fs/promises";
const copy = (from, to) =>
  cp(new URL(from, import.meta.url), new URL(to, import.meta.url), {
    recursive: true,
    verbatimSymlinks: true,
  });
await copy("../agent/", "./package/agent/");
// The agent imports the local test engine from ../packages/core.
await copy("../packages/core/", "./package/packages/core/");
