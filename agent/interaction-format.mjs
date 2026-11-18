export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export function recordingUrl(input) {
  const u = new URL(input);
  u.username = "";
  u.password = "";
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (/^(?:key|api[_-]?key|token|secret|signature|password|authorization)$/i.test(key))
      u.searchParams.set(key, "[redacted]");
  return u.toString();
}
export function sensitive(value) {
  if (typeof value === "string")
    return /Bearer\s+[A-Za-z0-9._-]+|(?:sk-|tyk_|tyr_|tym_|ghp_|ghs_)[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(
      value,
    );
  if (Array.isArray(value)) return value.some(sensitive);
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, v]) =>
        /^(?:password|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|api[_-]?key|jwt)$/i.test(
          key,
        ) || sensitive(v),
    );
  return false;
}
export async function interactionSignature(method, url, body) {
  const bytes = new globalThis.TextEncoder().encode(
      JSON.stringify(canonical({ method: method.toUpperCase(), url: recordingUrl(url), body })),
    ),
    digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function eligibleRecording(recording) {
  if (
    !recording.interactions.length ||
    recording.omissions.length ||
    sensitive(recording.interactions)
  )
    return false;
  const outputs = new Map();
  for (const item of recording.interactions) {
    const output = JSON.stringify(canonical(item.response));
    if (outputs.has(item.signature) && outputs.get(item.signature) !== output) return false;
    outputs.set(item.signature, output);
  }
  return true;
}
