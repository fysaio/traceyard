export interface SandboxIdentity {
  uid: number;
  gid: number;
  home: string;
}
export declare function sandboxIdentity(
  env?: Record<string, string | undefined>,
): Promise<SandboxIdentity | null>;
export declare function sandboxed<T extends { env?: Record<string, string | undefined> }>(
  sandbox: SandboxIdentity | null | undefined,
  options: T,
): T & { uid?: number; gid?: number };
export declare function grantToSandbox(
  sandbox: SandboxIdentity | null | undefined,
  path: string,
): Promise<void>;
export declare function readUntrustedFile(path: string, encoding?: BufferEncoding): Promise<string>;
