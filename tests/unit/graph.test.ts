import { describe, it, expect } from "vitest";
import {
  graphSchema,
  graphLayers,
  evaluateGraphNode,
  INITIAL_GRAPH,
} from "../../shared/workflow/graph";
describe("executable graphs", () => {
  it("validates a bounded graph and preserves dependency ordering", () => {
    const g = graphSchema.parse(INITIAL_GRAPH);
    expect(graphLayers(g).map((l) => l.map((n) => n.id))).toEqual([["input"], ["output"]]);
  });
  it("rejects cycles, duplicate nodes and missing connections", () => {
    expect(
      graphSchema.safeParse({
        ...INITIAL_GRAPH,
        edges: [
          ["input", "output"],
          ["output", "input"],
        ],
      }).success,
    ).toBe(false);
    expect(
      graphSchema.safeParse({
        ...INITIAL_GRAPH,
        nodes: [...INITIAL_GRAPH.nodes, INITIAL_GRAPH.nodes[0]],
      }).success,
    ).toBe(false);
    expect(graphSchema.safeParse({ ...INITIAL_GRAPH, edges: [] }).success).toBe(false);
  });
  it("allows independent branches in the same execution layer", () => {
    const graph = graphSchema.parse({
      nodes: [
        INITIAL_GRAPH.nodes[0],
        { id: "a", name: "A", type: "literal", config: { value: 1 } },
        { id: "b", name: "B", type: "literal", config: { value: 2 } },
        { id: "merge", name: "Merge", type: "merge" },
        INITIAL_GRAPH.nodes[1],
      ],
      edges: [
        ["input", "a"],
        ["input", "b"],
        ["a", "merge"],
        ["b", "merge"],
        ["merge", "output"],
      ],
    });
    expect(graphLayers(graph)[1]?.map((n) => n.id)).toEqual(["a", "b"]);
  });
  it("does not evaluate code or access object prototype fields", () => {
    const node = {
      id: "pick",
      name: "Pick",
      type: "pick" as const,
      config: { path: "customer.name" },
      x: 0,
      y: 0,
    };
    expect(evaluateGraphNode(node, null, [{ customer: { name: "Ada" } }])).toBe("Ada");
    expect(() =>
      evaluateGraphNode({ ...node, config: { path: "constructor" } }, null, [{}]),
    ).toThrow();
    expect(() => evaluateGraphNode({ ...node, config: { path: "missing" } }, null, [{}])).toThrow();
  });
});
