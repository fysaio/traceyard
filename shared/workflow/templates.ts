import type { GraphNode, WorkflowGraph } from "./graph";
export const WORKFLOW_ICONS = [
  "diagram-project",
  "robot",
  "file-lines",
  "headset",
  "magnifying-glass",
  "arrows-rotate",
  "code",
  "check-double",
  "shuffle",
  "layer-group",
  "flask",
  "bolt",
  "folder",
  "database",
  "globe",
  "envelope",
] as const;
const node = (
  id: string,
  type: GraphNode["type"],
  name: string,
  config: GraphNode["config"] = {},
  x = 0,
  y = 160,
): GraphNode => ({ id, type, name, config, x, y });
const input = node("input", "input", "Input", {}, 60),
  output = node("output", "output", "Output", {}, 1120);
const linear = (...nodes: GraphNode[]): WorkflowGraph => ({
  nodes: [input, ...nodes, output].map((n, i) => ({ ...n, x: 60 + i * 280 })),
  edges: [input, ...nodes, output].slice(1).map((n, i) => [[input, ...nodes][i]!.id, n.id]),
});
const model = (prompt: string) => node("model", "model", "Generate response", { prompt }, 340);
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  graph: WorkflowGraph;
  input: unknown;
  setup: string[];
}
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "document",
    name: "Document processing",
    description: "Summarize a document and review the result before returning it.",
    icon: "file-lines",
    graph: linear(
      model("Summarize the provided document. Preserve factual details."),
      node("review", "approval", "Review summary", {
        prompt: "Review the document summary.",
        expiresMinutes: 30,
      }),
    ),
    input: { title: "Incident review", document: "" },
    setup: ["Choose a model route."],
  },
  {
    id: "extraction",
    name: "Structured AI extraction",
    description: "Convert supplied text into parsed JSON with required fields.",
    icon: "code",
    graph: linear(
      model(
        "Extract title and summary from the supplied text. Return only a JSON object, without markdown fences.",
      ),
      node("text", "pick", "Response text", { path: "text" }),
      node("json", "parse", "Validate JSON", { requiredFields: ["title", "summary"] }),
    ),
    input: { document: "" },
    setup: ["Choose a model route."],
  },
  {
    id: "research",
    name: "Research agent",
    description: "Combine your source notes and draft a research brief for review.",
    icon: "magnifying-glass",
    graph: linear(
      model(
        "Write a research brief using only the supplied source notes. Cite the provided source labels. State any gaps.",
      ),
      node("review", "approval", "Review brief", {
        prompt: "Check the brief against the supplied sources.",
      }),
    ),
    input: { question: "", sources: [] },
    setup: ["Choose a model route.", "Supply the sources you want the brief to use."],
  },
  {
    id: "approval",
    name: "Human approval",
    description: "Review incoming data before allowing the workflow to continue.",
    icon: "check-double",
    graph: linear(
      node("review", "approval", "Review request", {
        prompt: "Review this request before continuing.",
        expiresMinutes: 30,
      }),
    ),
    input: { request: "" },
    setup: [],
  },
  {
    id: "sync",
    name: "Data synchronization",
    description: "Send a record to a connected HTTP endpoint and retain its response.",
    icon: "arrows-rotate",
    graph: linear(node("sync", "http", "Send record", {})),
    input: { customer_id: "", email: "" },
    setup: ["Choose an HTTP connection in the step inspector."],
  },
  {
    id: "fallback",
    name: "Provider fallback",
    description: "Use a Gateway route that falls back when a provider is unavailable.",
    icon: "shuffle",
    graph: linear(model("Answer the request using the supplied context.")),
    input: { request: "" },
    setup: ["Create a Gateway route with a primary model and a fallback, then select it."],
  },
  {
    id: "parallel",
    name: "Parallel processing",
    description: "Read two fields independently and combine their recorded results.",
    icon: "layer-group",
    graph: {
      nodes: [
        input,
        node("left", "pick", "Read customer", { path: "customer" }, 340, 70),
        node("right", "pick", "Read order", { path: "order" }, 340, 270),
        node("merge", "merge", "Combine results", {}, 650),
        { ...output, x: 950 },
      ],
      edges: [
        ["input", "left"],
        ["input", "right"],
        ["left", "merge"],
        ["right", "merge"],
        ["merge", "output"],
      ],
    },
    input: { customer: { name: "" }, order: { id: "" } },
    setup: [],
  },
  {
    id: "recovery",
    name: "Failure recovery",
    description:
      "Parse JSON and inspect retained state when validation fails. Recovery preserves completed steps and the captured version.",
    icon: "flask",
    graph: linear(node("json", "parse", "Parse JSON", {})),
    input: '{"message":"Hello"}',
    setup: [],
  },
];
export const AGENT_TEMPLATE: WorkflowTemplate = {
  ...WORKFLOW_TEMPLATES[0]!,
  id: "agent",
  name: "Untitled agent",
  description: "Generate a response and review it before completion.",
  icon: "robot",
  graph: linear(
    model("Respond to the supplied request."),
    node("review", "approval", "Review response", {
      prompt: "Review the response before completion.",
    }),
  ),
  input: { request: "" },
  setup: ["Choose a model route."],
};
export function templateById(id: string) {
  return id === "agent" ? AGENT_TEMPLATE : WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
