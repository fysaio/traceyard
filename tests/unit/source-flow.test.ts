import { describe, it, expect } from "vitest";
import { discoverFile } from "../../agent/discovery.mjs";
import { operationSchema } from "../../shared/repository/contracts";
import { sourceFlowSchema } from "../../shared/repository/source-flow";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceFlowTree } from "../../src/components/source-flow";
const flow = (code: string) => discoverFile("api.ts", code).operations[0]!.sourceFlow!;

describe("credential-free source call relationships", () => {
  it("follows known local helpers, leaving imported implementations unresolved", () => {
    const result = discoverFile(
      "api.ts",
      `import { db } from './database';
      function load(){return db.read();}
      const save = () => db.write();
      app.post('/work',async c=>{const value=await load(); save(value);return c.json(value);});`,
    );
    const f = result.operations[0]!.sourceFlow!;
    expect(f.steps.map((s) => [s.name, s.parentId, s.resolution])).toEqual([
      ["load", null, "local"],
      ["db.read", "c0", "unresolved"],
      ["save", null, "local"],
      ["db.write", "c2", "unresolved"],
      ["c.json", null, "unresolved"],
    ]);
    expect(operationSchema.safeParse(result.operations[0]).success).toBe(true);
  });
  it("labels possible branches without executing code or exporting secret values", () => {
    const f = flow(`app.post('/work',c=>{
      if(check()) yes('private-value'); else no();
      try { request(process.env.GROQ_API_KEY); } catch(error){ recover(error); }
      for(const x of items) repeat(x);
      items.map(x=>transform(x));
      enabled && conditional();
    });`);
    expect(f.steps.find((s) => s.name === "yes")?.context).toBe("conditional");
    expect(f.steps.find((s) => s.name === "no")?.context).toBe("conditional");
    expect(f.steps.find((s) => s.name === "recover")?.context).toBe("error");
    expect(f.steps.find((s) => s.name === "repeat")?.context).toBe("loop");
    expect(f.steps.find((s) => s.name === "transform")?.context).toBe("callback");
    expect(f.steps.find((s) => s.name === "conditional")?.context).toBe("conditional");
    expect(JSON.stringify(f)).not.toContain("private-value");
    expect(JSON.stringify(f)).not.toContain("GROQ_API_KEY");
  });
  it("does not invent calls from unused functions or resolve shadowed/reassigned bindings", () => {
    const f = flow(`function load(){return real();}
      app.get('/one', load=>{function unused(){never();} return load();});`);
    expect(f.steps.map((s) => s.name)).toEqual(["load"]);
    expect(f.steps[0]?.resolution).toBe("unresolved");
    expect(
      flow(`let load=()=>real();load=other;app.get('/',()=>load());`).steps[0]?.resolution,
    ).toBe("unresolved");
    expect(
      flow(`function load(){real();}var load=other;app.get('/',()=>load());`).steps[0]?.resolution,
    ).toBe("unresolved");
    expect(
      flow(`function load(){real();}app.get('/',()=>{const {load}=other;load();});`).steps[0]
        ?.resolution,
    ).toBe("unresolved");
  });
  it("bounds recursion, depth and call count while retaining a valid tree", () => {
    const recursive = flow(`function a(){b();}function b(){a();}app.get('/',()=>a());`);
    expect(recursive.steps.map((s) => s.resolution)).toEqual(["local", "local", "recursive"]);
    const bounded = flow(
      `app.get('/',()=>{${Array.from({ length: 20 }, (_, i) => `call${i}();`).join("")}});`,
    );
    expect(bounded.steps).toHaveLength(12);
    expect(bounded.truncated).toBe(true);
    expect(sourceFlowSchema.safeParse(bounded).success).toBe(true);
    const deep = flow(
      `function a(){b();}function b(){c();}function c(){d();}function d(){e();}app.get('/',()=>a());`,
    );
    expect(deep.steps.map((s) => s.name)).toEqual(["a", "b", "c", "d"]);
    expect(deep.truncated).toBe(true);
  });
  it("identifies unresolved dynamic calls and rejects cyclic/foreign graph parents", () => {
    expect(flow(`app.get('/',()=>handlers[key]());`).steps[0]).toMatchObject({
      name: "Dynamic call",
      resolution: "unresolved",
    });
    const f = flow(`app.get('/',()=>work());`);
    expect(
      sourceFlowSchema.safeParse({ ...f, steps: [{ ...f.steps[0], parentId: "c0" }] }).success,
    ).toBe(false);
    expect(
      sourceFlowSchema.safeParse({ ...f, steps: [{ ...f.steps[0], parentId: "c99" }] }).success,
    ).toBe(false);
  });
  it("retains direct discovery when deeper expansion is skipped for CPU limits", () => {
    const r = discoverFile("api.ts", `app.get('/',()=>load());`, { includeFlow: false });
    expect(r.operations[0]?.calls).toEqual(["load"]);
    expect(r.operations[0]?.sourceFlow).toBeUndefined();
  });
  it("renders an accessible source tree with file evidence and unresolved boundaries", () => {
    const f = flow(
      `function load(){try{database.read();}catch(e){recover();}}app.get('/',()=>load());`,
    );
    const html = renderToStaticMarkup(createElement(SourceFlowTree, { flow: f, file: "api.ts" }));
    expect(html).toContain("<details open");
    expect(html).toContain("<summary>");
    expect(html).toContain("database.read");
    expect(html).toContain("Error path");
    expect(html).toContain("Not resolved in this file");
    expect(html).toContain("api.ts:");
    expect(html).not.toContain("Completed");
    expect(html).not.toContain("<svg");
  });
});
