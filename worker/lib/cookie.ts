const COOKIE_NAME = "ty_session";
const AUTH_COOKIE_NAME = "ty_auth_session";
const OAUTH_STATE_COOKIE_NAME = "ty_oauth_state";
const OAUTH_VERIFIER_COOKIE_NAME = "ty_oauth_pkce";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export { AUTH_COOKIE_NAME, COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME };

function readToken(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName !== name) continue;
    const value = rest.join("=");
    return TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}

export function readSessionToken(cookieHeader: string | null): string | null {
  return readToken(cookieHeader, COOKIE_NAME);
}

export function readAuthSessionToken(cookieHeader: string | null): string | null {
  return readToken(cookieHeader, AUTH_COOKIE_NAME);
}

export function readOAuthState(cookieHeader: string | null): string | null {
  return readToken(cookieHeader, OAUTH_STATE_COOKIE_NAME);
}

export function readOAuthVerifier(cookieHeader: string | null): string | null {
  return readToken(cookieHeader, OAUTH_VERIFIER_COOKIE_NAME);
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

export function authSessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return scopedCookie(AUTH_COOKIE_NAME, token, secure, maxAgeSeconds);
}

export function oauthCookie(name: string, token: string, secure: boolean): string {
  return scopedCookie(name, token, secure, 600);
}

export function clearCookie(name: string, secure: boolean): string {
  return scopedCookie(name, "", secure, 0);
}

function scopedCookie(name: string, value: string, secure: boolean, maxAgeSeconds: number): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
