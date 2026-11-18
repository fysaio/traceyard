import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
export const graphNodeSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(100),
    type: z.enum([
      "input",
      "literal",
      "pick",
      "merge",
      "output",
      "model",
      "approval",
      "map",
      "condition",
      "parse",
      "http",
    ]),
    config: z
      .object({
        value: z.unknown().optional(),
        path: z.string().max(200).optional(),
        routeId: z.string().max(80).optional(),
        connectionId: z.string().max(80).optional(),
        requiredFields: z.array(z.string().min(1).max(100)).max(20).optional(),
        prompt: z.string().max(6000).optional(),
        expiresMinutes: z.number().int().min(1).max(60).optional(),
        limit: z.number().int().min(1).max(20).optional(),
        equals: z.unknown().optional(),
        thenTarget: identifier.optional(),
        elseTarget: identifier.optional(),
        retry: z
          .object({
            maxAttempts: z.number().int().min(1).max(5),
            baseDelayMs: z.number().int().min(100).max(30000),
            backoff: z.enum(["fixed", "exponential"]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
    x: z.number().min(0).max(10000).default(40),
    y: z.number().min(0).max(10000).default(40),
  })
  .strict();
export const graphDraftSchema = z
  .object({
    nodes: z.array(graphNodeSchema).max(40),
    edges: z.array(z.tuple([identifier, identifier])).max(120),
  })
  .strict();
export const graphSchema = graphDraftSchema.superRefine((graph, ctx) => {
  const errors = graphErrors(graph);
  for (const message of errors) ctx.addIssue({ code: "custom", message });
});
export type WorkflowGraph = { nodes: z.infer<typeof graphNodeSchema>[]; edges: [string, string][] };
export type GraphNode = WorkflowGraph["nodes"][number];
export function graphErrors(graph: WorkflowGraph): string[] {
  const errors: string[] = [],
    ids = new Set(graph.nodes.map((n) => n.id));
  if (ids.size !== graph.nodes.length) errors.push("Step IDs must be unique.");
  if (graph.nodes.filter((n) => n.type === "input").length !== 1)
    errors.push("Use exactly one input step.");
  if (graph.nodes.filter((n) => n.type === "output").length !== 1)
    errors.push("Use exactly one output step.");
  if (graph.nodes.filter((n) => n.type === "approval").length > 4)
    errors.push("Use at most four approval steps per workflow.");
  const edges = new Set<string>();
  for (const [a, b] of graph.edges) {
    if (!ids.has(a) || !ids.has(b) || a === b)
      errors.push("Every connection must join two existing, different steps.");
    if (edges.has(a + ":" + b)) errors.push("Connections must be unique.");
    edges.add(a + ":" + b);
  }
  for (const n of graph.nodes) {
    const incoming = graph.edges.filter(([, b]) => b === n.id),
      outgoing = graph.edges.filter(([a]) => a === n.id);
    if (n.type === "input" && incoming.length)
      errors.push("The input cannot have incoming connections.");
    if (n.type !== "input" && !incoming.length) errors.push(`Connect an input to ${n.name}.`);
    if (n.type === "output" && outgoing.length)
      errors.push("The output cannot have outgoing connections.");
    if (n.type !== "output" && !outgoing.length)
      errors.push(`Connect ${n.name} to the output path.`);
    if (
      ["pick", "output", "map", "condition", "parse", "http"].includes(n.type) &&
      incoming.length !== 1
    )
      errors.push(`${n.name} needs exactly one incoming connection.`);
  }
  for (const node of graph.nodes) {
    if (node.config.retry && !["http", "model"].includes(node.type))
      errors.push(`Retry policies are supported on HTTP and model steps, not ${node.name}.`);
    if (node.type === "condition") {
      const targets = graph.edges.filter(([a]) => a === node.id).map(([, b]) => b);
      if (!Object.hasOwn(node.config, "equals"))
        errors.push(`Set a comparison value for ${node.name}.`);
      if (
        !node.config.thenTarget ||
        !node.config.elseTarget ||
        node.config.thenTarget === node.config.elseTarget ||
        targets.length !== 2 ||
        !targets.includes(node.config.thenTarget) ||
        !targets.includes(node.config.elseTarget)
      )
        errors.push(
          `Connect ${node.name} to two different steps and choose its true and false paths.`,
        );
    }
    if (node.type === "http" && !node.config.connectionId)
      errors.push(`Choose an HTTP connection for ${node.name}.`);
    if (node.type === "model" && !node.config.routeId)
      errors.push(`Choose a model route for ${node.name}.`);
    if (node.type === "map" && !node.config.limit)
      errors.push(`Set an iteration limit for ${node.name}.`);
  }
  if (graphLayers(graph).flat().length !== graph.nodes.length)
    errors.push("Connections must not form a cycle.");
  return [...new Set(errors)];
}
export function graphLayers(graph: WorkflowGraph): GraphNode[][] {
  const done = new Set<string>(),
    layers: GraphNode[][] = [];
  for (;;) {
    const ready = graph.nodes.filter(
      (n) =>
        !done.has(n.id) && graph.edges.filter(([, b]) => b === n.id).every(([a]) => done.has(a)),
    );
    if (!ready.length) return layers;
    layers.push(ready);
    ready.forEach((n) => done.add(n.id));
  }
}
export function graphStepPolicy(node: GraphNode) {
  return {
    timeoutMs: node.type === "model" ? 120000 : node.type === "http" ? 30000 : 10000,
    retry: node.config.retry ?? { maxAttempts: 1, baseDelayMs: 0, backoff: "fixed" as const },
  };
}
export function evaluateGraphNode(node: GraphNode, input: unknown, sources: unknown[]): unknown {
  if (node.type === "input") return input;
  if (node.type === "literal") return node.config.value ?? null;
  if (node.type === "output") return sources[0] ?? null;
  if (node.type === "merge") return sources;
  if (node.type === "parse") {
    if (typeof sources[0] !== "string") throw new Error("JSON parsing requires a text input.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(sources[0]);
    } catch {
      throw new Error("The input is not valid JSON.");
    }
    for (const field of node.config.requiredFields ?? [])
      if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, field))
        throw new Error("Required JSON field is missing: " + field);
    return parsed;
  }
  if (node.type === "condition") {
    const value = evaluateGraphNode({ ...node, type: "pick" }, null, sources);
    return JSON.stringify(value) === JSON.stringify(node.config.equals);
  }
  if (node.type === "map") {
    const items = sources[0];
    if (!Array.isArray(items)) throw new Error("Map input must be an array.");
    if (items.length > (node.config.limit ?? 20))
      throw new Error("Map input exceeds its configured iteration limit.");
    return items.map((item) => evaluateGraphNode({ ...node, type: "pick" }, null, [item]));
  }
  if (node.type === "model" || node.type === "approval" || node.type === "http")
    throw new Error("This step requires the execution service.");
  let value = sources[0];
  for (const key of (node.config.path ?? "").split(".").filter(Boolean)) {
    if (
      ["__proto__", "constructor", "prototype"].includes(key) ||
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      throw new Error(`Path “${node.config.path}” was not found in the input.`);
    value = (value as Record<string, unknown>)[key];
  }
  return value ?? null;
}
export const INITIAL_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "input", name: "Input", type: "input", config: {}, x: 60, y: 120 },
    { id: "output", name: "Output", type: "output", config: {}, x: 400, y: 120 },
  ],
  edges: [["input", "output"]],
};
