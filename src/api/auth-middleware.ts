import type { EventSink } from "../engine/types.ts";
import type {
  IdentityProvider,
  TokenGrant,
  UserIdentity,
  VerifiedIdentity,
} from "../identity/provider.ts";
import { TransientAuthError } from "../identity/provider.ts";
import { log } from "../observability/log.ts";
import { constantTimeEqual, validateInternalToken } from "./auth-utils.ts";

// ── Auth mode detection ───────────────────────────────────────────

export type AuthMode = { type: "adapter"; provider: IdentityProvider } | { type: "dev" };

/**
 * Determine the auth mode from the available configuration.
 * IdentityProvider (from instance.json or DevIdentityProvider) > dev mode (no provider).
 */
export function resolveAuthMode(provider: IdentityProvider | null): AuthMode {
  if (provider) return { type: "adapter", provider };
  return { type: "dev" };
}

// ── Middleware ─────────────────────────────────────────────────────

export interface AuthMiddlewareOptions {
  /** Auth mode — adapter or dev. */
  mode: AuthMode;
  /** Internal token for connector-to-host calls (scoped to chat endpoints). */
  internalToken: string;
  /** Event sink for audit logging. */
  eventSink: EventSink;
}

/** Successful auth result — identity is undefined for internal tokens and dev mode. */
export type AuthSuccess = { identity: UserIdentity | undefined };

/** Auth check result: a Response (rejection) or AuthSuccess. */
export type AuthResult = Response | AuthSuccess;

/** Type guard to distinguish auth rejection (Response) from success. */
export function isAuthError(result: AuthResult): result is Response {
  return result instanceof Response;
}

/**
 * Authenticate a request against the configured auth mode.
 *
 * Checks in order:
 * 1. Internal token (scoped to chat endpoints — always checked first for connector-to-host calls)
 * 2. IdentityProvider.verifyRequest() when mode is "adapter", then the
 *    credential's grant against `resource` (see {@link grantAdmits})
 * 3. Pass-through when mode is "dev"
 *
 * `resource` is the canonical URL of the protected resource the request
 * addresses (`/mcp/<wsId>`), or undefined for every other route.
 *
 * Returns { identity } on success, or a Response (401/403) on failure.
 */
export async function authenticateRequest(
  req: Request,
  options: AuthMiddlewareOptions,
  resource?: string,
): Promise<AuthResult> {
  const { mode, internalToken } = options;

  // Extract bearer token if present
  const authHeader = req.headers.get("authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  // 1. Always check internal token first (connector-to-host calls)
  if (bearerToken && constantTimeEqual(bearerToken, internalToken)) {
    const url = new URL(req.url);
    const error = validateInternalToken(bearerToken, internalToken, url.pathname, req.method);
    if (error) return error;
    return { identity: undefined };
  }

  // 2. Dev mode — no auth required
  if (mode.type === "dev") {
    return { identity: undefined };
  }

  // 3. IdentityProvider mode
  if (mode.type === "adapter") {
    const verified = await verifyWithProvider(req, mode.provider);
    if (verified instanceof Response) return verified;
    if (verified) {
      const { grant, ...identity } = verified;
      if (grantAdmits(grant, resource)) return { identity };
      // A valid token presented where it is not valid: 401 so a client
      // re-runs discovery and obtains one for this resource.
      log.warn("[auth] token audience does not name this resource", {
        path: new URL(req.url).pathname,
      });
    }
    // Unauthenticated
    logAuthFailure(req, options.eventSink);
    return new Response(null, { status: 401 });
  }

  // Unreachable, but satisfy TypeScript
  return new Response(null, { status: 401 });
}

/**
 * Run the provider's verification. A {@link TransientAuthError} becomes 503:
 * verification never reached a verdict — our dependency failed, not the
 * caller's token. A 401 here is indistinguishable from a revoked session to the
 * web client, whose post-refresh retry leg treats any 401 as terminal and logs
 * the user out. 503 keeps the session: REST surfaces a transient error, streams
 * reconnect with backoff.
 *
 * NOT audited. `audit.auth_failure` is a security signal about callers; our own
 * JWKS outage is an availability event and would dilute it.
 */
async function verifyWithProvider(
  req: Request,
  provider: IdentityProvider,
): Promise<VerifiedIdentity | null | Response> {
  try {
    return await provider.verifyRequest(req);
  } catch (err) {
    if (err instanceof TransientAuthError) {
      log.warn("[auth] verification unavailable", { reason: err.reason });
      return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
    }
    throw err;
  }
}

/**
 * Whether a verified credential is valid for the request's resource. The rule
 * is here, above every provider, so it holds whatever the provider is:
 *
 * - A first-party credential (the web app's login) is not bound to a resource;
 *   it is valid on every route, and membership gates what it reaches.
 * - A resource token is valid only at the resource it was minted for: its
 *   audience must contain the canonical URL exactly. No prefix match and no
 *   normalization — the authorization server echoes the client's `resource`
 *   verbatim and mints for sub-paths, so anything looser admits a token minted
 *   for another resource. A route that is no protected resource (`resource`
 *   undefined: all of `/v1/*`) admits no resource token.
 *
 * The audience prevents replay; it does not authorize. Membership of the
 * workspace a resource names stays the gate.
 */
export function grantAdmits(grant: TokenGrant, resource: string | undefined): boolean {
  if (grant.kind === "first_party") return true;
  return resource !== undefined && grant.audience.includes(resource);
}

// ── Helpers ───────────────────────────────────────────────────────

function logAuthFailure(req: Request, eventSink: EventSink): void {
  const ip = req.headers.get("x-forwarded-for") ?? "direct";
  log.warn("[auth] authentication failed", { ip });
  eventSink.emit({
    type: "audit.auth_failure",
    data: { ip, method: req.method, path: new URL(req.url).pathname },
  });
}
