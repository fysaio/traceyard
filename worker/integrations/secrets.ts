import { serviceUnavailable } from "../api/errors";
declare global {
  interface Env {
    INTEGRATION_ENCRYPTION_KEY?: string;
  }
}
async function key(env: Env) {
  const secret = env.INTEGRATION_ENCRYPTION_KEY;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array([...atob(secret ?? "")].map((c) => c.charCodeAt(0)));
  } catch {
    throw serviceUnavailable(
      "SECRET_STORAGE_UNCONFIGURED",
      "Configure the integration encryption key on the Worker.",
    );
  }
  if (bytes.length !== 32)
    throw serviceUnavailable(
      "SECRET_STORAGE_UNCONFIGURED",
      "Configure a 32-byte base64 integration encryption key on the Worker.",
    );
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(env: Env, value: string, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
        await key(env),
        new TextEncoder().encode(value),
      ),
    );
  return btoa(String.fromCharCode(...iv, ...encrypted));
}
export async function decryptSecret(env: Env, ciphertext: string, context: string) {
  const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, 12),
        additionalData: new TextEncoder().encode(context),
      },
      await key(env),
      bytes.slice(12),
    ),
  );
}

export function secretStorageConfigured(env: Env) {
  try {
    return atob(env.INTEGRATION_ENCRYPTION_KEY ?? "").length === 32;
  } catch {
    return false;
  }
}
