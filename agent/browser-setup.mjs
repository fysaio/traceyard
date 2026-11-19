import { execFileSync } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { isFilePath, shaPattern } from "./browser-site.mjs";

export async function browserSetupCommand(args) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { "runner-revision": { type: "string" } },
  });
  const [buildPath] = positionals;
  if (positionals.length !== 1 || !isFilePath(buildPath))
    throw Error("Usage: traceyard setup-browser <build directory> [--runner-revision SHA]");
  const hasDefault = await access(".traceyard/browser-journey.json").then(
    () => true,
    () => false,
  );
  const named = await readdir(".traceyard/browser").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  if (!hasDefault && !named.some((name) => /^[a-zA-Z0-9_-]+[.]json$/.test(name)))
    throw Error("Record a journey under .traceyard/browser/ first.");
  const revision =
    values["runner-revision"] ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    }).trim();
  if (!shaPattern.test(revision)) throw Error("Use a published full Traceyard commit SHA.");
  const workflow = await readFile(
    new URL("../runner/browser-workflow.yml", import.meta.url),
    "utf8",
  );
  await mkdir(".github/workflows", { recursive: true });
  const file = ".github/workflows/traceyard-browser.yml";
  await writeFile(
    file,
    workflow.replace("__BUILD_PATH__", buildPath).replace("__RUNNER_REVISION__", revision),
    { flag: "wx" },
  );
  console.log("Created " + file + ". Review it and the journey together before merging.");
}
