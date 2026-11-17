import type { SourceFlow } from "../shared/repository/source-flow";
export interface DiscoveredOperation {
  id: string;
  name: string;
  kind: "http" | "job";
  file: string;
  line: number;
  calls: string[];
  sourceFlow?: SourceFlow;
  evidence: "source";
}
export function discoverFile(
  file: string,
  source: string,
  options?: { includeFlow?: boolean },
): { operations: DiscoveredOperation[]; warning?: string };
