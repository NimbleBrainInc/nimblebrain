export function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    mismatch |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
  }
  return mismatch === 0;
}

/**
 * Paths that the internal token is allowed to access.
 * Internal tokens are scoped to chat endpoints only — no tool calls,
 * resource access, or other privileged operations.
 */
export const INTERNAL_TOKEN_ALLOWED_PATHS = new Set(["/v1/chat", "/v1/chat/stream"]);

/**
 * Validate an internal token against the expected value and the requested path.
 *
 * Returns null if access is granted (token matches AND path is allowed).
 * Returns a Response (401 or 403) if access is denied.
 */
export function validateInternalToken(
  bearerToken: string,
  internalToken: string,
  pathname: string,
  method: string,
): Response | null {
  if (!constantTimeEqual(bearerToken, internalToken)) {
    return new Response(null, { status: 401 });
  }
  // Token is valid — enforce path scope (POST only)
  if (method !== "POST" || !INTERNAL_TOKEN_ALLOWED_PATHS.has(pathname)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
