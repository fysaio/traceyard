import { parse } from "@babel/parser";

// A conservative source index. A discovered entry point is not proof of execution.
export function discoverFile(file, source) {
  const operations = [];
  let ast;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
      errorRecovery: false,
    });
  } catch {
    return { operations, warning: `Could not parse ${file}.` };
  }
  const visit = (node, fn) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string") fn(node);
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "tokens", "comments"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((v) => visit(v, fn));
      else if (value && typeof value === "object") visit(value, fn);
    }
  };
  const name = (n) =>
    n?.type === "Identifier"
      ? n.name
      : n?.type === "MemberExpression"
        ? `${name(n.object)}.${name(n.property)}`
        : "";
  const functions = new Map();
  visit(ast, (n) => {
    if (n.type === "FunctionDeclaration" && n.id) functions.set(n.id.name, n);
    if (
      n.type === "VariableDeclarator" &&
      n.id?.type === "Identifier" &&
      ["ArrowFunctionExpression", "FunctionExpression"].includes(n.init?.type)
    )
      functions.set(n.id.name, n.init);
  });
  function add(n, operationName, kind, handler) {
    const target = handler?.type === "Identifier" ? functions.get(handler.name) : handler;
    const calls = new Set();
    if (target)
      visit(target.body, (child) => {
        if (child.type === "CallExpression") {
          const value = name(child.callee);
          if (value && !value.startsWith("console.")) calls.add(value);
        }
      });
    const line = n.loc?.start.line ?? 1;
    operations.push({
      id: `${file}:${line}:${n.start ?? 0}`,
      name: operationName.slice(0, 200),
      kind,
      file,
      line,
      calls: [...calls].slice(0, 12),
      evidence: "source",
    });
  }
  const verbs = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
  visit(ast, (n) => {
    if (n.type === "CallExpression") {
      const callee = name(n.callee);
      const method = callee.split(".").at(-1);
      const first = n.arguments?.[0];
      if (verbs.has(method) && first?.type === "StringLiteral" && n.arguments.length >= 2) {
        // Only conventional HTTP routers; foo.get('key') is not an HTTP workflow.
        const receiver = callee.split(".").slice(0, -1).join(".");
        if (/^(?:app|router|server|routes|fastify|api)(?:\.|$)/.test(receiver))
          add(n, `${method.toUpperCase()} ${first.value}`, "http", n.arguments.at(-1));
      }
      if (callee === "Deno.serve") add(n, "HTTP handler", "http", n.arguments.at(-1));
      if (
        ["queue.process", "worker.process", "cron.schedule", "schedule.scheduleJob"].includes(
          callee,
        )
      )
        add(n, first?.value ? `${callee}: ${first.value}` : callee, "job", n.arguments.at(-1));
    }
    if (
      n.type === "ExportNamedDeclaration" &&
      /(?:^|\/)app\/(?:.*\/)?route\.[cm]?[jt]sx?$/.test(file)
    ) {
      const d = n.declaration;
      if (d?.type === "FunctionDeclaration" && verbs.has(d.id?.name?.toLowerCase()))
        add(d, d.id.name + " " + file, "http", d);
      for (const v of d?.declarations ?? [])
        if (verbs.has(v.id?.name?.toLowerCase())) add(v, v.id.name + " " + file, "http", v.init);
    }
    if (n.type === "ExportDefaultDeclaration" && /(?:^|\/)pages\/api\//.test(file))
      add(n, "API " + file, "http", n.declaration);
  });
  return { operations: operations.slice(0, 100) };
}
