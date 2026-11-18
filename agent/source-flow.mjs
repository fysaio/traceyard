// Bounded, possible call relationships; never an observed execution timeline.
const ignored = new Set(["loc", "start", "end", "tokens", "comments"]);
const children = (node) => Object.entries(node).filter(([key]) => !ignored.has(key));
const callable = (node) =>
  ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node?.type);
const nameOf = (node) =>
  node?.type === "Identifier"
    ? node.name
    : node?.type === "ThisExpression"
      ? "this"
      : ["MemberExpression", "OptionalMemberExpression"].includes(node?.type) && !node.computed
        ? [nameOf(node.object), nameOf(node.property)].filter(Boolean).join(".")
        : "";

function boundNames(node, into) {
  if (!node || typeof node !== "object") return;
  if (node.type === "Identifier") into.add(node.name);
  else if (node.type === "ObjectPattern")
    node.properties.forEach((p) => boundNames(p.value ?? p.argument, into));
  else if (node.type === "ArrayPattern") node.elements.forEach((p) => boundNames(p, into));
  else if (node.type === "AssignmentPattern") boundNames(node.left, into);
  else if (node.type === "RestElement") boundNames(node.argument, into);
}
const shadowCache = new WeakMap();
function shadows(fn) {
  if (shadowCache.has(fn)) return shadowCache.get(fn);
  const names = new Set();
  fn.params?.forEach((p) => boundNames(p, names));
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator") boundNames(node.id, names);
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration")
      boundNames(node.id, names);
    if (callable(node)) return;
    for (const [, value] of children(node))
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
  };
  walk(fn.body);
  shadowCache.set(fn, names);
  return names;
}
function scope(fn, parent) {
  let names;
  return () => (names ??= new Set([...(parent ? parent() : []), ...shadows(fn)]));
}
export function sourceDefinitions(program) {
  const definitions = new Map();
  const add = (name, node) => {
    if (name) definitions.set(name, definitions.has(name) ? null : callable(node) ? node : null);
  };
  for (const statement of program.body) {
    const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (node?.type === "FunctionDeclaration") add(node.id?.name, node);
    for (const d of node?.declarations ?? [])
      if (d.id.type === "Identifier") add(d.id.name, d.init);
  }
  return definitions;
}
export function sourceFlow(handler, definitions) {
  const steps = [];
  const calls = new Set();
  let truncated = false;
  if (!callable(handler)) return { flow: { steps, truncated }, calls: [] };
  const walk = (node, parentId, context, depth, active, shadowed) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") return;
    if (callable(node)) {
      walk(node.body, parentId, "callback", depth, active, scope(node, shadowed));
      return;
    }
    if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
      walk(node.test, parentId, context, depth, active, shadowed);
      walk(node.consequent, parentId, "conditional", depth, active, shadowed);
      walk(node.alternate, parentId, "conditional", depth, active, shadowed);
      return;
    }
    if (node.type === "LogicalExpression") {
      walk(node.left, parentId, context, depth, active, shadowed);
      walk(node.right, parentId, "conditional", depth, active, shadowed);
      return;
    }
    if (node.type === "SwitchCase") context = "conditional";
    if (node.type === "CatchClause") {
      const caught = () => {
        const names = new Set(shadowed());
        boundNames(node.param, names);
        return names;
      };
      walk(node.body, parentId, "error", depth, active, caught);
      return;
    }
    if (/^(?:For|While|DoWhile)/.test(node.type)) context = "loop";
    if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
      const name = nameOf(node.callee) || "Dynamic call";
      if (!name.startsWith("console.")) {
        if (parentId === null && calls.size < 12) calls.add(name.slice(0, 150));
        if (steps.length === 12) {
          truncated = true;
          return;
        }
        const definition = node.callee.type === "Identifier" ? definitions.get(name) : null;
        const target = definition && !shadowed().has(name) ? definition : null;
        const recursive = !!target && active.has(target);
        const step = {
          id: "c" + steps.length,
          parentId,
          name: name.slice(0, 150),
          line: node.loc?.start.line ?? 1,
          ...(context ? { context } : {}),
          resolution: recursive ? "recursive" : target ? "local" : "unresolved",
        };
        steps.push(step);
        if (target && !recursive) {
          if (depth === 3) truncated = true;
          else
            walk(
              target.body,
              step.id,
              context,
              depth + 1,
              new Set([...active, target]),
              scope(target),
            );
        }
      }
    }
    for (const [, value] of children(node))
      if (Array.isArray(value))
        value.forEach((child) => walk(child, parentId, context, depth, active, shadowed));
      else walk(value, parentId, context, depth, active, shadowed);
  };
  walk(handler.body, null, undefined, 0, new Set([handler]), scope(handler));
  return { flow: { steps, truncated }, calls: [...calls] };
}
