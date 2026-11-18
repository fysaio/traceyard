// Trusted bootstrap: the application repository does not control this package.
import { cp } from "node:fs/promises";
await cp(new URL("../agent/", import.meta.url), new URL("./package/agent/", import.meta.url), {
  recursive: true,
  verbatimSymlinks: true,
});
