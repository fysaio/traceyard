import type { DiscoveredOperation } from "./discovery.mjs";
export function scanDirectory(
  root: string,
): Promise<{ operations: DiscoveredOperation[]; filesScanned: number; warnings: string[] }>;
export function main(args?: string[]): Promise<void>;
