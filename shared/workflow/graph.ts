import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
export const graphNodeSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(100),
    type: z.enum(["input", "literal", "pick", "merge", "output"]),
    config: z
      .object({ value: z.unknown().optional(), path: z.string().max(200).optional() })
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
    if (["pick", "output"].includes(n.type) && incoming.length !== 1)
      errors.push(`${n.name} needs exactly one incoming connection.`);
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
export function evaluateGraphNode(node: GraphNode, input: unknown, sources: unknown[]): unknown {
  if (node.type === "input") return input;
  if (node.type === "literal") return node.config.value ?? null;
  if (node.type === "output") return sources[0] ?? null;
  if (node.type === "merge") return sources;
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
