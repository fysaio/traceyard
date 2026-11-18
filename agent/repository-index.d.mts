import type { IndexedFile, RepositoryPackage, RepositoryIndexManifest } from "../shared/contracts/repository-index";
export interface RepositoryIndex { schemaVersion: 1; snapshotId: string; packages: RepositoryPackage[]; files: IndexedFile[]; coverage: RepositoryIndexManifest["coverage"] }
export function analyzeRepositoryFiles(files: { path: string; content: string }[]): RepositoryIndex;
export function indexRepository(directory: string): Promise<RepositoryIndex>;
export function relatedTests(index: RepositoryIndex, sourcePath: string): { path: string; packageDirectory: string; tests: IndexedFile["tests"] }[];
