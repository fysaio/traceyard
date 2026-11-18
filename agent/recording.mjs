import { readFile } from "node:fs/promises";
import { eligibleRecording } from "./interaction-format.mjs";
export async function buildRecording(path, sourceCommit, testPath) {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    /* No supported fetch was exercised. */
  }
  const manifest = {
    schemaVersion: 1,
    kind: "json-fetch",
    sourceCommit,
    testPath,
    interactions: [],
    environment: [],
    omissions: [],
    eligible: false,
  };
  if (text.length > 256000) {
    manifest.omissions.push("Capture exceeded its artifact budget.");
    return manifest;
  }
  const events = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    environment = new Map();
  for (const event of events) {
    if (event.kind === "interaction") {
      if (manifest.interactions.length < 8) manifest.interactions.push(event.item);
      else manifest.omissions.push("Interaction count exceeded the replay budget.");
      for (const item of event.environment ?? []) environment.set(item.name, item);
    } else if (event.kind === "omission") manifest.omissions.push(event.reason);
  }
  manifest.environment = [...environment.values()].slice(0, 30);
  if (!sourceCommit) manifest.omissions.push("The exact source revision is unknown.");
  if (!manifest.interactions.length)
    manifest.omissions.push("No eligible JSON fetch response was recorded.");
  while (Buffer.byteLength(JSON.stringify(manifest)) > 23000 && manifest.interactions.length) {
    manifest.interactions.pop();
    manifest.omissions.push("Recording data exceeded its upload budget.");
  }
  manifest.omissions = [...new Set(manifest.omissions)].slice(0, 20);
  manifest.eligible = eligibleRecording(manifest);
  return manifest;
}
