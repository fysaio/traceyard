import type { RecordingManifest } from "../shared/contracts/recordings";
export function buildRecording(
  path: string,
  sourceCommit: string | null,
  testPath: string,
): Promise<RecordingManifest>;
