export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";
export interface DetectedPackageManager {
  name: PackageManagerName;
  major: number | null;
  installRoot: string;
  source: "packageManager" | "lockfile" | "default";
  lockfile: string | null;
}
export interface Command {
  program: string;
  args: string[];
}
type ManagerInput = PackageManagerName | { name: PackageManagerName; major?: number | null };
export function parsePackageManagerField(
  value: unknown,
): { name: PackageManagerName; major: number } | null;
export function detectPackageManager(
  root: string,
  packageDirectory?: string,
): Promise<DetectedPackageManager>;
export function scriptCommand(manager: ManagerInput, script: string, args?: string[]): Command;
export function installCommand(manager: ManagerInput): Command;
