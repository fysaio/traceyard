export interface DiscoveredOperation {
  id: string;
  name: string;
  kind: "http" | "job";
  file: string;
  line: number;
  calls: string[];
  evidence: "source";
}
export function discoverFile(
  file: string,
  source: string,
): { operations: DiscoveredOperation[]; warning?: string };
