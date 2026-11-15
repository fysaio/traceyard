import { badRequest } from "../api/errors";
declare global {
  interface Env {
    OUTBOUND_ALLOWED_HOSTS?: string;
  }
}
export function outboundUrl(env: Env, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest("INVALID_DESTINATION", "Enter an HTTPS destination.");
  }
  const allowed = (env.OUTBOUND_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !/[a-z]/iu.test(url.hostname) ||
    !url.hostname.includes(".") ||
    !allowed.includes(url.hostname.toLowerCase())
  )
    throw badRequest(
      "DESTINATION_NOT_ALLOWED",
      "This HTTPS destination must be explicitly enabled in OUTBOUND_ALLOWED_HOSTS.",
    );
  return url.toString();
}
