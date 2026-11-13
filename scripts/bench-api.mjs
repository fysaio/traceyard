#!/usr/bin/env node
/**
 * Bounded, read-only latency probe for a running Traceyard Worker.
 *
 * This is deliberately dependency-free and never mutates state. It is a local
 * smoke benchmark, not a production capacity claim: run it against `npm run dev`
 * (Miniflare) or a preview deployment and treat the numbers as relative.
 *
 * Usage:
 *   npm run bench:api -- --url http://localhost:5173 --requests 60 --concurrency 6
 */

const DEFAULTS = {
  url: "http://localhost:5173",
  requests: 30,
  concurrency: 4,
  warmup: 3,
  timeoutMs: 10_000,
};

const PATHS = ["/api/health", "/api/workflows", "/api/overview?days=14"];

function readNumber(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, received ${raw ?? "<missing>"}`);
  }
  return value;
}

function readString(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

const config = {
  url: readString("url", DEFAULTS.url).replace(/\/+$/u, ""),
  requests: readNumber("requests", DEFAULTS.requests),
  concurrency: readNumber("concurrency", DEFAULTS.concurrency),
  warmup: readNumber("warmup", DEFAULTS.warmup),
  timeoutMs: readNumber("timeout", DEFAULTS.timeoutMs),
};

if (config.concurrency > config.requests) {
  throw new Error("--concurrency cannot exceed --requests");
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

async function probe(path) {
  const started = performance.now();
  const response = await fetch(`${config.url}${path}`, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const body = await response.arrayBuffer();
  const durationMs = performance.now() - started;
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status} (${body.byteLength} bytes)`);
  }
  return { durationMs, bytes: body.byteLength };
}

async function measure(path) {
  const samples = [];
  let bytes = 0;
  let next = 0;

  async function worker() {
    while (next < config.requests) {
      next += 1;
      const sample = await probe(path);
      samples.push(sample.durationMs);
      bytes += sample.bytes;
    }
  }

  const started = performance.now();
  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  const elapsedMs = performance.now() - started;
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    path,
    requests: samples.length,
    concurrency: config.concurrency,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    throughputPerSecond: Number(((samples.length / elapsedMs) * 1_000).toFixed(1)),
    meanMs: Number((total / sorted.length).toFixed(2)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 0.99).toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
    meanBytes: Math.round(bytes / samples.length),
  };
}

async function main() {
  process.stdout.write(
    `Traceyard API probe · ${config.url} · ${config.requests} requests/path · concurrency ${config.concurrency}\n`,
  );

  for (const path of PATHS) {
    for (let index = 0; index < config.warmup; index += 1) {
      await probe(path);
    }
  }

  const results = [];
  for (const path of PATHS) {
    results.push(await measure(path));
  }

  for (const result of results) {
    process.stdout.write(
      `${result.path.padEnd(34)} p50 ${String(result.p50Ms).padStart(7)} ms  ` +
        `p95 ${String(result.p95Ms).padStart(7)} ms  p99 ${String(result.p99Ms).padStart(7)} ms  ` +
        `${String(result.throughputPerSecond).padStart(7)} req/s  ${result.meanBytes} B\n`,
    );
  }

  process.stdout.write(`\n${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `bench:api failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
