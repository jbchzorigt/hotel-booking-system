/**
 * Client-side JWT payload inspection.
 *
 * The signature is verified by the backend on every request — the client
 * only reads claims to hydrate UI state (role, tenant scope, expiry).
 * Never make an authorization decision on the client from these values.
 */

export interface AccessTokenClaims {
  sub: string;
  realm: "app" | "police";
  role: string;
  tenant_id: string | null;
  restaurant_id: string | null;
  exp: number;
  iat: number;
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "="
  );
  return atob(padded);
}

export function decodeAccessToken(token: string): AccessTokenClaims | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(segments[1]));
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
      return null;
    }
    return payload as AccessTokenClaims;
  } catch {
    return null;
  }
}

export function isExpired(claims: AccessTokenClaims): boolean {
  return claims.exp * 1000 <= Date.now();
}
