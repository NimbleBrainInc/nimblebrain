import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { InstanceConfig } from "./instance.ts";
import { OidcIdentityProvider } from "./providers/oidc.ts";
import { WorkosIdentityProvider } from "./providers/workos.ts";
import type { OrgRole } from "./types.ts";
import type { User, UserPreferences, UserStore } from "./user.ts";

// ── UserIdentity ───────────────────────────────────────────────────

/** Auth context returned by successful authentication — strict subset of User. */
export interface UserIdentity {
  id: string;
  email: string;
  displayName: string;
  orgRole: OrgRole;
  /** Per-user preferences (timezone, locale, theme). Populated from local profile. */
  preferences: UserPreferences;
}

// ── Provider capabilities ──────────────────────────────────────────

/** Declares what this provider supports — checked by handlers, not instanceof. */
export interface ProviderCapabilities {
  /** Supports redirect-based login (auth code flow). */
  authCodeFlow: boolean;
  /** Supports token refresh. */
  tokenRefresh: boolean;
  /** Provider owns the user directory (skip local UserStore for CRUD). */
  managedUsers: boolean;
  /** Provider is also an OAuth authorization server external clients can discover. */
  authorizationServer: boolean;
}

// ── Authorization server ───────────────────────────────────────────

/** Where an external MCP client goes to obtain a token for this instance. */
export interface AuthorizationServer {
  /** The `iss` value, and the entry point clients advertise and validate against. */
  issuer: string;
  /**
   * Where the issuer's own metadata document lives, when the runtime proxies
   * it for clients that predate Protected Resource Metadata. Omit when the
   * issuer publishes nothing to proxy.
   */
  metadataUrl?: string;
}

// ── Token exchange ─────────────────────────────────────────────────

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
}

/**
 * Thrown by {@link IdentityProvider.verifyRequest} when verification could not
 * reach a verdict — as opposed to reaching a negative one.
 *
 * `verifyRequest` returning `null` means "this caller is not authenticated":
 * a definitive answer the client acts on by re-authenticating. But some
 * failures are not about the caller at all — a JWKS fetch that failed against
 * a cold cache, an identity-provider API error with nothing cached to fall
 * back to. The token is probably fine; we could not check it this instant.
 *
 * Collapsing the two makes a backend hiccup indistinguishable from a revoked
 * session, and the web client logs the user out on the second one. This is the
 * same distinction {@link RefreshTokenError}'s `unavailable` kind already draws
 * on the refresh hop; verification is the hop that was missing it.
 *
 * Providers own the classification — only they understand their SDK's failure
 * shapes. `authenticateRequest` maps this to 503 + `Retry-After` and does not
 * audit it; every terminal check keeps returning `null` and its 401.
 */
export class TransientAuthError extends Error {
  /** Provider-specific reason for logging/triage (e.g. `jwks_unavailable`). */
  readonly reason: string;
  constructor(reason: string, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TransientAuthError";
    this.reason = reason;
  }
}

/**
 * Why a refresh failed — the distinction the refresh handler acts on.
 *
 * - `rejected`    — the IdP gave a definitive verdict that this end-user's
 *                   refresh token is no longer valid (expired/revoked/reused).
 *                   The session is genuinely over → re-authenticate.
 * - `unavailable` — the refresh hop failed *without* a definitive verdict: a
 *                   thrown network error, a 5xx/429 from the IdP, a timeout, or
 *                   a deployment misconfig (bad client credentials). The
 *                   end-user's token is probably fine; we just couldn't reach a
 *                   verdict this instant → keep the session and retry.
 */
export type RefreshFailureKind = "rejected" | "unavailable";

/**
 * Thrown by {@link IdentityProvider.refreshToken} to tell the handler which
 * kind of failure occurred. Providers own this classification because only they
 * understand their SDK's error shapes — the handler must stay provider-agnostic
 * (it maps `kind` → HTTP status and never sniffs vendor error fields).
 */
export class RefreshTokenError extends Error {
  readonly kind: RefreshFailureKind;
  /** Provider-specific code for logging/triage (e.g. the OAuth error code). */
  readonly code?: string;
  constructor(
    kind: RefreshFailureKind,
    message: string,
    options?: { code?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RefreshTokenError";
    this.kind = kind;
    this.code = options?.code;
  }
}

// ── User management ────────────────────────────────────────────────

export interface CreateUserInput {
  email: string;
  displayName: string;
  orgRole?: OrgRole;
}

export interface CreateUserResult {
  user: User;
}

export interface UpdateUserInput {
  email?: string;
  displayName?: string;
  orgRole?: OrgRole;
}

// ── IdentityProvider interface ─────────────────────────────────────

/**
 * The single interface every identity provider implements.
 *
 * Capabilities are data, not types — handlers check `provider.capabilities`
 * instead of using `instanceof`. Adding a new provider never requires
 * touching handler code.
 */
export interface IdentityProvider {
  /** What this provider supports. Checked by handlers to gate features. */
  readonly capabilities: ProviderCapabilities;

  /** Get the authorization URL for redirect login (only called by /v1/auth/authorize). */
  getAuthorizationUrl?(): string;

  /**
   * The OAuth authorization server external MCP clients should discover, if
   * this provider is one. Returns null when it is not, or when the deployment
   * has not configured one. Guarded by `capabilities.authorizationServer`.
   */
  authorizationServer?(): AuthorizationServer | null;

  /** Verify an incoming request and return the authenticated identity, or null. */
  verifyRequest(req: Request): Promise<UserIdentity | null>;

  // ── Auth code flow (optional — guarded by capabilities.authCodeFlow) ──

  /** Exchange an authorization code for tokens. Accepts optional PKCE code_verifier. */
  exchangeCode?(code: string, codeVerifier?: string): Promise<TokenResult>;

  /**
   * Refresh an access token using a refresh token. On failure, throws a
   * {@link RefreshTokenError} whose `kind` tells the handler whether the
   * session is dead (`rejected`) or the hop was merely transient (`unavailable`).
   */
  refreshToken?(refreshToken: string): Promise<TokenResult>;

  // ── User management ──────────────────────────────────────────────

  /** List all users known to this provider. */
  listUsers(): Promise<User[]>;

  /** Create a new user. */
  createUser(data: CreateUserInput): Promise<CreateUserResult>;

  /** Update a user by ID. Returns the updated user, or null if not found. */
  updateUser?(userId: string, data: UpdateUserInput): Promise<User | null>;

  /** Delete a user by ID. Returns true if deleted, false if not found. */
  deleteUser(userId: string): Promise<boolean>;

  /** Invalidate cached identity for a user (e.g., after preferences change). */
  invalidateUser?(userId: string): void;
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Create the appropriate identity provider based on instance config.
 * Returns null when config is null (dev mode — no auth).
 */
export function createIdentityProvider(
  config: InstanceConfig | null,
  userStore: UserStore,
  workspaceStore: WorkspaceStore,
): IdentityProvider | null {
  if (config === null) return null;

  const adapter = config.auth.adapter;

  switch (adapter) {
    case "oidc":
      return new OidcIdentityProvider(config.auth, userStore, workspaceStore);
    case "workos":
      return new WorkosIdentityProvider(config.auth, userStore, workspaceStore);
    default:
      throw new Error(`Unknown identity provider: "${adapter as string}"`);
  }
}
