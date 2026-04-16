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
}

// ── Token exchange ─────────────────────────────────────────────────

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
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

  /** Verify an incoming request and return the authenticated identity, or null. */
  verifyRequest(req: Request): Promise<UserIdentity | null>;

  // ── Auth code flow (optional — guarded by capabilities.authCodeFlow) ──

  /** Exchange an authorization code for tokens. Accepts optional PKCE code_verifier. */
  exchangeCode?(code: string, codeVerifier?: string): Promise<TokenResult>;

  /** Refresh an access token using a refresh token. */
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
): IdentityProvider | null {
  if (config === null) return null;

  const adapter = config.auth.adapter;

  switch (adapter) {
    case "oidc":
      return new OidcIdentityProvider(config.auth, userStore);
    case "workos":
      return new WorkosIdentityProvider(config.auth, userStore);
    default:
      throw new Error(`Unknown identity provider: "${adapter as string}"`);
  }
}
