import type { RecordingManifest } from "../shared/contracts/recordings";
export function canonical(value: unknown): unknown;
export function recordingUrl(input: string): string;
export function sensitive(value: unknown): boolean;
export function interactionSignature(method: string, url: string, body: unknown): Promise<string>;
export function eligibleRecording(recording: RecordingManifest): boolean;
