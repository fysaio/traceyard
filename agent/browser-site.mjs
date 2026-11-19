import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

export const shaPattern = /^[a-f0-9]{40}$/;
export const isFilePath = (value) =>
  /^[a-zA-Z0-9_@.-]+(?:\/[a-zA-Z0-9_@.-]+)*$/.test(value) &&
  !value.split("/").some((part) => part.startsWith("."));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function git(directory, args, encoding) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000,
  });
}

export function readCommitSite(directory, commit, site) {
  if (
    !shaPattern.test(commit) ||
    git(directory, ["rev-parse", "--verify", commit + "^{commit}"], "utf8").trim() !== commit
  )
    throw Error("Provide a full Git commit SHA for each revision.");
  const files = new Map();
  const prefix = site + "/";
  const listing = git(directory, ["ls-tree", "-rz", "--full-tree", commit, "--", site], "utf8");
  for (const entry of listing.split("\0")) {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/s.exec(entry);
    if (!match || !match[2].startsWith(prefix)) continue;
    const path = match[2].slice(prefix.length);
    if (isFilePath(path) && Object.hasOwn(contentTypes, extname(path)))
      files.set("/" + path, match[1]);
  }
  return siteAssets(files, (blob) => git(directory, ["cat-file", "blob", blob]));
}

export async function readBuildSite(directory) {
  const root = await realpath(directory);
  const files = new Map();
  const rows = [];
  let totalBytes = 0;
  async function visit(subpath) {
    const entries = await readdir(join(root, subpath), { withFileTypes: true });
    for (const entry of entries) {
      const path = subpath ? subpath + "/" + entry.name : entry.name;
      if (!isFilePath(path)) continue;
      if (entry.isSymbolicLink()) throw Error("Browser builds must contain regular files.");
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && Object.hasOwn(contentTypes, extname(path))) {
        const location = resolve(root, path);
        const { size } = await lstat(location);
        if (size > 16 * 1024 * 1024 || files.size >= 10000)
          throw Error("Browser build is too large.");
        totalBytes += size;
        if (totalBytes > 128 * 1024 * 1024) throw Error("Browser build is too large.");
        const bytes = await readFile(location);
        files.set("/" + path, bytes);
        rows.push([path, createHash("sha256").update(bytes).digest("hex")]);
      }
    }
  }
  await visit("");
  const hash = createHash("sha256");
  for (const row of rows.sort()) hash.update(JSON.stringify(row) + "\n");
  return { ...siteAssets(files, (bytes) => bytes), buildSha256: hash.digest("hex") };
}

function siteAssets(files, read) {
  if (!files.has("/index.html")) throw Error("The browser build is missing its root index.html.");
  return {
    async get(pathname, navigation) {
      const path = decodeURIComponent(pathname);
      const index = path.endsWith("/") ? path + "index.html" : path + "/index.html";
      const asset = files.has(path)
        ? path
        : files.has(index)
          ? index
          : navigation && !extname(path)
            ? "/index.html"
            : null;
      if (!asset) return;
      return { contentType: contentTypes[extname(asset)], body: await read(files.get(asset)) };
    },
  };
}
