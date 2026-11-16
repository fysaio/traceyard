import { describe, it, expect } from "vitest";
import { discoverFile } from "../../agent/discovery.mjs";
import { convertOtlp } from "../../worker/repositories/otlp";
import { runnerWorkflow } from "../../worker/repositories/runner-workflow";
describe("repository discovery and runtime evidence", () => {
  it("finds real route declarations and direct calls, without matching comments or data getters", () => {
    const r = discoverFile(
      "server.ts",
      `// app.get('/fake', handler)\nconst text="app.get('/also-fake', handler)";\nconst a=cache.get('value');\napp.post('/interpret', async c=>{const context=await loadContext();return await model.generate(context);});`,
    );
    expect(r.operations.map((o) => o.name)).toEqual(["POST /interpret"]);
    expect(r.operations[0]?.calls).toEqual(["loadContext", "model.generate"]);
    expect(r.operations[0]?.evidence).toBe("source");
  });
  it("indexes Next and Deno entry points, resolves named handlers, and reports syntax failures", () => {
    expect(
      discoverFile("src/app/api/chat/route.ts", `export async function POST(){return reply();}`)
        .operations[0]?.name,
    ).toContain("POST");
    expect(
      discoverFile(
        "supabase/functions/interpret/index.ts",
        `const handle=async(req: Request)=>work(req);Deno.serve(handle);`,
      ).operations[0]?.calls,
    ).toEqual(["work"]);
    expect(discoverFile("broken.ts", `export function {`).warning).toContain("Could not parse");
  });
  it("converts actual OTLP timing and parent relationships while excluding captured URLs, payloads and SQL", () => {
    const start = "1760000000000000000";
    const spans = convertOtlp({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "Somni" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "1".repeat(32),
                  spanId: "2".repeat(16),
                  name: "POST /interpret",
                  startTimeUnixNano: start,
                  endTimeUnixNano: "1760000000100000000",
                  attributes: [
                    { key: "db.statement", value: { stringValue: "private SQL" } },
                    {
                      key: "url.full",
                      value: { stringValue: "https://example.test/?token=secret" },
                    },
                  ],
                  status: { code: 2 },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(spans[0]).toMatchObject({
      kind: "workflow",
      status: "FAILED",
      attributes: { service: "Somni" },
      error: "Operation failed",
    });
    expect(Date.parse(spans[0]!.endedAt) - Date.parse(spans[0]!.startedAt)).toBe(100);
    expect(JSON.stringify(spans)).not.toContain("private SQL");
    expect(JSON.stringify(spans)).not.toContain("token=secret");
  });
  it("generates a pinned GitHub-hosted check with OIDC and no long-lived API secret", () => {
    const content = runnerWorkflow("https://traceyard.example", "main", "a".repeat(40));
    expect(content).toContain("id-token: write");
    expect(content).toContain("ubuntu-latest");
    expect(content).toContain('paths: [".github/workflows/traceyard.yml"]');
    expect(content).toContain("timeout-minutes: 10");
    expect(content).toContain("cancel-in-progress: true");
    expect(content).toContain("cache: npm");
    expect(content).toContain("persist-credentials: false");
    expect(content).toContain("a".repeat(40));
    expect(content).not.toContain("TRACEYARD_KEY");
    expect(content).not.toContain("pull_request_target");
  });
});
