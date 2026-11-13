const COOKIE_NAME = "ty_session";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export { COOKIE_NAME };

export function readSessionToken(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName !== COOKIE_NAME) continue;
    const value = rest.join("=");
    return TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}

export function sessionCookie(token: string, secure: boolean): string {
  const attributes = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${60 * 60 * 24 * 180}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
