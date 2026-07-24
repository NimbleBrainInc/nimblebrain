import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type OAuthClientProvider,
  selectClientAuthMethod,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { validateBundleUrl } from "../bundles/url-validator.ts";
import type { ConnectorOwner } from "../identity/connector-owner.ts";
import { buildTenantAssertion } from "../oauth/fleet-assertion.ts";
import { log } from "../observability/log.ts";
import { validateAdditionalAuthorizationParams } from "../util/oauth-params.ts";
import type { WorkspaceContext } from "../workspace/context.ts";
import { type FlowOwner, register as registerInteractiveFlow } from "./oauth-flow-registry.ts";

/**
 * Sentinel kept for callers that import the symbol. The original
 * fast-fail behavior is gone — interactive OAuth is now supported by
 * registering with the flow registry and awaiting via the
 * `onInteractiveAuthRequired` callback. Any code that still throws this
 * is a regression.
 *
 * @deprecated Interactive OAuth is supported. The provider now throws
 * the SDK's own `UnauthorizedError` after registering the flow, which
 * `McpSource.start()` catches and retries via `awaitPendingFlow`.
 */
export class InteractiveOAuthNotSupportedError extends Error {
  constructor(public readonly authorizationUrl: string) {
    super(
      `Interactive OAuth not yet supported in this build. The remote MCP server ` +
        `requires browser authorization at:\n  ${authorizationUrl}\n` +
        `Only headless flows (e.g. Reboot's Anonymous dev provider) are supported today.`,
    );
    this.name = "InteractiveOAuthNotSupportedError";
  }
}

/**
 * Thrown by `redirectToAuthorization` when the authorization server demands an
 * INTERACTIVE (browser) round-trip but this start attempt is NOT user-initiated
 * — i.e. a boot source's auto-start or one of its `HealthMonitor` liveness
 * reconnects (both reuse the boot provider with the flag unarmed). No human is
 * waiting, so registering an `oauth-flow-registry` flow would only block
 * `start()` on `awaitPendingFlow()` for the full 15-minute flow TTL and then
 * fail — the headless-reconnect crash loop this fix removes. The provider
 * instead flips the connection to `reauth_required` (via `notifyAuthLost`) and
 * throws this so `start()` fails fast. The UI's Reconnect runs `startAuth`,
 * which builds a fresh provider and arms interactive auth for that one attempt.
 */
export class BackgroundReauthRequiredError extends Error {
  constructor(public readonly serverName: string) {
    super(
      `[workspace-oauth-provider] ${serverName} needs interactive reauthorization, but no ` +
        `user-initiated flow is active — surfacing reauth_required instead of blocking a ` +
        `background start on a browser flow no one will complete.`,
    );
    this.name = "BackgroundReauthRequiredError";
  }
}

/**
 * Discriminated union identifying who "owns" an OAuth connection — the
 * thing whose tokens these are. Two top-level shapes:
 *
 *   - `{ type: "workspace", wsId }` — credentials shared by every member
 *     of the workspace. One DCR'd client identity represents
 *     "NimbleBrain on behalf of `<wsId>`". Tokens persist under
 *     `<workDir>/workspaces/<wsId>/credentials/mcp-oauth/<server>/`.
 *
 *   - `{ type: "user", userId }` — credentials owned by a single user,
 *     visible across every workspace they're a member of. The user's
 *     personal Granola / Gmail / etc. Tokens persist under
 *     `<workDir>/users/<userId>/credentials/mcp-oauth/<server>/` —
 *     entirely outside the workspace tree, so leaving a workspace does
 *     not orphan the credentials.
 *
 * Both shapes share the same on-disk file layout under their root:
 * `client.json` (DCR client info), `tokens.json` (access + refresh),
 * `verifier.json` (PKCE), `identity.json` (OIDC claims when issued).
 */
export type OAuthOwnerContext = ConnectorOwner;

export interface WorkspaceOAuthProviderOptions {
  /**
   * The principal whose tokens these are — either a workspace (shared)
   * or a single user (personal). Drives both the credential storage
   * path and the principal id used in connection state tracking.
   */
  owner: OAuthOwnerContext;
  /**
   * Human-readable label for the owner, used verbatim in the OAuth
   * `client_name` the vendor renders on its consent screen ("NimbleBrain
   * (<ownerDisplayName>) would like access…"). When omitted, the provider
   * falls back to the raw owner id (`owner.wsId` / `user:<userId>`), which
   * is an opaque token the end user can't read and a tenant identifier we'd
   * rather not hand a third party. Callers resolve this from the
   * workspace's `name` (see `resolveWorkspaceDisplayName`); it's purely
   * cosmetic — the vendor mints a distinct `client_id` per registration
   * regardless — so a missing name degrades gracefully to the id.
   */
  ownerDisplayName?: string;
  serverName: string;
  workDir: string;
  /**
   * Workspace-bound context to derive the on-disk path from. Optional;
   * when present AND `owner.type === "workspace"`, the provider asserts
   * `workspaceContext.workspaceId === owner.wsId` and resolves the
   * credential directory through `workspaceContext.getDataPath(...)`
   * instead of reconstructing `workspaces/{wsId}/credentials/mcp-oauth/...`
   * from `workDir`. This is the preferred path for new construction sites
   * — it removes one independent place that builds workspace-scoped paths.
   * The classic `(owner, workDir)` construction remains valid for user-
   * scoped owners and for legacy call sites pending migration in
   * a follow-up migration.
   *
   * When `workspaceContext` is provided AND `owner.type !== "workspace"`,
   * construction throws — user-scope owners store tokens under
   * `users/{userId}/...`, outside any workspace, so pairing them with a
   * workspace context is a category error. Construction with a
   * user-scoped owner and no `workspaceContext` is fine (the legacy
   * `workDir`-derivation path applies).
   */
  workspaceContext?: WorkspaceContext;
  /** Absolute callback URL — must match the /v1/mcp-auth/callback route. */
  callbackUrl: string;
  /**
   * Whether loopback / RFC1918 / cloud-metadata hosts are acceptable targets
   * for the authorize chain. Mirrors the platform-level `allowInsecureRemotes`
   * flag; when `false` (production default), every hop of the authorize
   * redirect chain is passed through `validateBundleUrl` to block SSRF
   * against internal infrastructure (AWS IMDS, RFC1918 admin panels,
   * NimbleBrain's own loopback ports).
   */
  allowInsecureRemotes?: boolean;
  /**
   * Fired once the provider has determined the OAuth flow requires a real
   * browser (the headless redirect probe didn't land on our callback).
   *
   * The provider invokes this callback synchronously *before* throwing
   * `UnauthorizedError`, with the authorization URL the caller's browser
   * should be sent to. The receiver typically:
   *
   *   1. Transitions its Connection to `pending_auth`
   *   2. Stores the URL so `/v1/mcp-auth/initiate` can find it
   *   3. Emits a `connection.state_changed` SSE event for the UI banner
   *
   * The flow is also already registered with `oauth-flow-registry` by the
   * time this callback fires, so a `state` value is bound to the
   * `(wsId, serverName)` pair and ready to be resolved by the callback
   * route.
   *
   * Errors thrown from this callback are swallowed (the provider must
   * still throw `UnauthorizedError` to escape the SDK auth flow). Keep
   * the implementation cheap and defensive.
   */
  onInteractiveAuthRequired?: (authorizationUrl: string) => void;
  /**
   * Fired when an already-established connection loses its authorization
   * mid-session — i.e. a tool call fails with `UnauthorizedError` because the
   * persisted refresh token was rejected (expired / revoked / conditional-access
   * pulled). The owner (`(wsId, serverName)`) is implicit in this provider, so
   * the callback carries no args; the wiring records the documented
   * `running → reauth_required` transition (see `connection.ts`) so the UI shows
   * "Reconnect" instead of silently failing every call. Distinct from
   * `onInteractiveAuthRequired` (an active flow → `pending_auth`); this is the
   * passive "your live connection just went stale" signal. Invoked via
   * `notifyAuthLost()`, which de-dupes so repeated failing calls flip state once.
   */
  onAuthLost?: () => void;
  /**
   * Pre-registered OAuth client (Track A). When present, the provider
   * skips DCR — `clientInformation()` returns this static client and
   * `saveClientInformation()` is a no-op. The client_secret is supplied
   * separately via the `clientSecret` field below; the catalog entry
   * referenced this via `oauthClient.clientSecret = { ref: "credential",
   * key: ... }`, and the route handler resolves it before constructing
   * the provider.
   */
  staticClient?: {
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
  };
  /**
   * OAuth scopes for `clientMetadata.scope`. Threaded into the SDK's
   * authorize URL build so the AS sees the requested permissions.
   * Omit for DCR servers that derive scopes from server metadata.
   */
  scopes?: string[];
  /**
   * Extra query params appended to the authorize URL inside
   * `redirectToAuthorization`. Reserved keys (`client_id`, `redirect_uri`,
   * `response_type`, `state`, `code_challenge`, `code_challenge_method`,
   * `scope`) are validated out at config-load time.
   */
  additionalAuthorizationParams?: Record<string, string>;
  /**
   * AbortSignal threaded into every outbound `fetch()` the provider
   * makes — the redirect-probe loop in `redirectToAuthorization` and
   * the revocation requests in `revokeAndDeleteTokens`. Lifecycle
   * aborts this when its 15s `startAuth` timeout fires (or when the
   * race resolves cleanly), so an unresponsive auth server's TCP
   * read doesn't outlive the user's intent.
   *
   * Optional — flows started outside the lifecycle path (CLI utilities,
   * tests) may not have a signal. fetches without one keep their
   * default behavior (no cancellation).
   */
  abortSignal?: AbortSignal;
  /**
   * Opt in to the server-side authorize-redirect probe — a HEADLESS-only
   * optimization. When true, `redirectToAuthorization` fetches the
   * authorize URL server-side and follows the redirect chain to extract a
   * code without a browser (Reboot's `Anonymous` dev provider 302s
   * straight to our callback with `?code=…`).
   *
   * Default false, and it MUST stay false for normal interactive
   * providers. Probing a real OAuth server (Granola, Claude.ai, etc.)
   * issues a genuine server-side `/authorize` request that spins up a live
   * authorization session bound to our PKCE `code_challenge` BEFORE the
   * user acts — which the vendor then treats as a competing/abandoned
   * attempt and rejects the user's real code at exchange (`invalid_code`)
   * or strands the flow. A standard client never touches `/authorize`
   * server-side; it just hands the URL to the browser. So: probe only when
   * the bundle is known-headless.
   */
  headlessAuthProbe?: boolean;
  /**
   * Issuer URL of the MCP fleet authorizer, e.g.
   * `https://fleet-authorizer.internal`. When set, the provider attaches a
   * signed tenant assertion to the `/token` request — but ONLY when
   * the token endpoint belongs to this issuer. It is NEVER attached to a vendor
   * authorization server (Granola, Google, …): a tenant key signature must not
   * leak to a third party. Leave unset for every provider except the one
   * driving the fleet-token flow; the assertion also no-ops when the tenant key
   * (`NB_MCP_AUTHORIZER_TENANT_KEY`) isn't provisioned (rollout phase 1).
   */
  fleetAuthorizerIssuer?: string;
}

/**
 * Normalize a callback URL to a `{origin, pathname}` canonical form so the
 * self-match check tolerates trivial differences a strict `===` would miss:
 * trailing slash on pathname, explicit default port vs implicit, hostname
 * case. The pathname is stripped of trailing `/` and compared case-sensitively
 * (paths are case-sensitive); the origin is lowercased.
 */
function canonicalEndpoint(u: URL): string {
  const origin = u.origin.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${origin}${path}`;
}

/** Lowercased origin of a URL string, or undefined if it doesn't parse. */
function originOf(value: string | URL): string | undefined {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Apply OAuth 2.1 client authentication to a token request. This mirrors the
 * MCP SDK's internal `applyClientAuthentication` (in
 * `@modelcontextprotocol/sdk/client/auth.js`), which the SDK runs by default
 * but which is NOT exported. We reproduce it because defining
 * `addClientAuthentication` on the provider REPLACES the SDK's default for
 * every token endpoint — so the provider must re-apply client auth itself.
 * The method-selection half (`selectClientAuthMethod`) IS exported and is
 * reused. Kept faithful to RFC 6749 §2.3.1; pinned against the SDK by
 * fleet-assertion.test.ts ("fleet hook — SDK client-auth parity"), which
 * exercises all three auth methods. If the SDK changes its apply logic, update
 * this mirror and those tests together.
 */
function applyClientAuthentication(
  method: ReturnType<typeof selectClientAuthMethod>,
  clientInformation: OAuthClientInformationMixed,
  headers: Headers,
  params: URLSearchParams,
): void {
  const { client_id, client_secret } = clientInformation;
  switch (method) {
    case "client_secret_basic":
      if (!client_secret) {
        throw new Error("client_secret_basic authentication requires a client_secret");
      }
      headers.set("Authorization", `Basic ${btoa(`${client_id}:${client_secret}`)}`);
      return;
    case "client_secret_post":
      params.set("client_id", client_id);
      if (client_secret) params.set("client_secret", client_secret);
      return;
    case "none":
      params.set("client_id", client_id);
      return;
    default: {
      // Compile-time drift canary. `method` is the SDK's exported
      // `ClientAuthMethod` union; once the three cases above are handled it
      // narrows to `never` here. If a future SDK bump adds an auth method, this
      // assignment stops compiling and the typecheck job fails — forcing this
      // mirror to be updated alongside the SDK, rather than silently throwing at
      // runtime in a fleet deployment.
      const unsupported: never = method;
      throw new Error(`Unsupported client authentication method: ${String(unsupported)}`);
    }
  }
}

/**
 * Discover the OAuth authorization-server origins for a resource (the MCP
 * bundle URL). Tries RFC 9728 (Protected Resource Metadata) first to
 * support vendors where the AS lives at a different origin than the
 * resource (Google, Microsoft); falls back to the bundle origin itself
 * for co-located deployments (Granola, Notion, HubSpot).
 *
 * Returns the list of AS origins to probe for token-revocation metadata.
 * Order: RFC 9728-listed origins first (most specific signal), bundle
 * origin appended last as the universal fallback. Duplicates removed
 * preserving order.
 *
 * Best-effort — network errors at the protected-resource layer return
 * just the bundle-origin fallback. SSRF-validated by the caller (the
 * fetcher itself doesn't enforce, since revocation discovery happens
 * post-auth in a trusted context).
 */
async function discoverAuthorizationServerOrigins(
  fetchImpl: typeof fetch,
  bundleOrigin: string,
  allowInsecure: boolean,
): Promise<string[]> {
  const origins = new Set<string>();
  // 1. RFC 9728 — Protected Resource Metadata.
  try {
    const prMetadataUrl = `${bundleOrigin}/.well-known/oauth-protected-resource`;
    validateBundleUrl(new URL(prMetadataUrl), { allowInsecure });
    const res = await fetchImpl(prMetadataUrl);
    if (res.ok) {
      const body = (await res.json()) as { authorization_servers?: unknown };
      if (Array.isArray(body.authorization_servers)) {
        for (const entry of body.authorization_servers) {
          if (typeof entry !== "string") continue;
          try {
            origins.add(new URL(entry).origin);
          } catch {
            // ignore malformed entries
          }
        }
      }
    }
  } catch {
    // RFC 9728 not advertised — fall through to the bundle-origin
    // probe below. This is the common case for vendors where the AS
    // lives at the same origin as the MCP server.
  }
  // 2. Bundle origin always appended as the last fallback (covers
  //    Granola/Notion/HubSpot pattern). Set deduplicates.
  origins.add(bundleOrigin);
  return [...origins];
}

/**
 * POST to an RFC 7009 revocation endpoint. Returns `true` for any 2xx
 * response (or 4xx with `invalid_token` per RFC 7009 § 2.2 — the token
 * is "considered already invalid" which counts as success for our
 * purposes). Throws on network errors so the caller can decide whether
 * to log + continue or surface.
 *
 * Encoded as `application/x-www-form-urlencoded` per RFC 7009 § 2.1.
 * client_id is always sent; client_secret only when the client info
 * declares secret-based auth (DCR clients with `token_endpoint_auth_method:
 * "none"` skip the secret).
 */
async function postRevoke(
  fetchImpl: typeof fetch,
  endpoint: string,
  token: string,
  tokenTypeHint: "access_token" | "refresh_token",
  clientInfo: OAuthClientInformationMixed,
): Promise<boolean> {
  const params = new URLSearchParams();
  params.set("token", token);
  params.set("token_type_hint", tokenTypeHint);
  params.set("client_id", clientInfo.client_id);
  // Attach client_secret if the registration carries one. Public PKCE-
  // only clients (DCR with `token_endpoint_auth_method: "none"`) won't
  // have a secret — `client_secret in clientInfo` is the discriminator.
  if ("client_secret" in clientInfo && typeof clientInfo.client_secret === "string") {
    params.set("client_secret", clientInfo.client_secret);
  }

  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    // Don't follow redirects on a request that carries the refresh token +
    // client_secret: `validateBundleUrl` vetted `endpoint`, but a 307/308
    // would re-POST the credential body to an unvetted `Location` (a
    // cross-origin/internal target). `manual` keeps the credential on the
    // validated origin — the redirect is surfaced as a non-2xx (RFC 7009
    // servers respond directly, so a 3xx is non-conformant) and falls through
    // to the failed-revoke return below, never chased.
    redirect: "manual",
  });

  if (res.ok) return true;
  // RFC 7009 § 2.2: "If the server is unable to locate the token using
  // the given hint, it MUST extend its search across all of its supported
  // token types." Some servers respond 400 invalid_token if the token's
  // already invalid — treat as success for revocation purposes.
  if (res.status === 400) {
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error === "invalid_token") return true;
    } catch {
      // body wasn't JSON — fall through
    }
  }
  return false;
}

/**
 * Parse an OIDC id_token's payload claims. Returns the relevant subset
 * (`sub`, `email`, `name`) or `null` if the token doesn't look like a
 * JWT or the payload isn't valid JSON.
 *
 * Deliberately does NOT verify the signature. Two reasons:
 *
 *   1. The token came directly from the AS over TLS (the SDK fetches
 *      the token endpoint), which is the trust anchor we already rely
 *      on for the access_token itself.
 *   2. We treat the parsed claims as informational only — they're shown
 *      in the Connections page UI, never used for access decisions.
 *
 * Catching `email_verified=false` is also out of scope: the upstream AS
 * controls verification and we surface what they tell us.
 */
/**
 * Hard ceiling on id_token byte length we'll attempt to parse. JWT payloads
 * in practice run well under 4KB; 16KB leaves headroom for AS-specific
 * extensions while bounding the cost of malicious or malformed tokens. A
 * 1MB id_token would cost real CPU through atob + JSON.parse otherwise.
 */
const ID_TOKEN_MAX_LENGTH = 16 * 1024;

function parseIdTokenClaims(
  idToken: string,
): { sub?: string; email?: string; name?: string } | null {
  if (idToken.length > ID_TOKEN_MAX_LENGTH) return null;
  // JWT shape: header.payload.signature — three base64url segments
  // separated by dots. We only need the payload (segment index 1).
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const payloadB64 = parts[1];
  if (!payloadB64) return null;
  // base64url → base64 (replace url-safe chars + pad)
  const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  let payloadJson: string;
  try {
    // atob returns a binary string treating bytes as Latin-1; that mangles
    // multibyte UTF-8 names (e.g. "山田太郎"). Decode through Uint8Array +
    // TextDecoder so the JSON parses as the bytes the AS actually sent.
    const binary = atob(padded + padding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    payloadJson = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const out: { sub?: string; email?: string; name?: string } = {};
  if (typeof claims.sub === "string") out.sub = claims.sub;
  if (typeof claims.email === "string") out.email = claims.email;
  if (typeof claims.name === "string") out.name = claims.name;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Validate a member id before it composes into a filesystem path. Same
 * shape as the credential-store key validator (alphanumerics + `._-`,
 * length-bounded, no `..` / `.`). Reuses the same allowed-character set
 * the platform's credential store uses so member ids and credential keys
 * have a single safe-name story.
 */
const OWNER_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
function assertSafeOwnerId(ownerId: string): void {
  if (
    typeof ownerId !== "string" ||
    ownerId.length === 0 ||
    ownerId.length > 128 ||
    !OWNER_ID_RE.test(ownerId) ||
    ownerId === "." ||
    ownerId === ".."
  ) {
    throw new Error(
      `[workspace-oauth-provider] invalid owner id: "${ownerId}". ` +
        "Must be 1-128 chars matching /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.",
    );
  }
}

/**
 * The OAuth credential dir for a connector: `<owner-root>/credentials/mcp-oauth/
 * <serverName>/` — `workspaces/<wsId>/…` for a workspace owner, `users/<userId>/…`
 * for a user (the identity-owned personal-connector home, outside any workspace;
 * see AGENTS.md "Credentials live with their owner"). THE single construction of
 * this path: the provider constructor writes here and the disconnect teardown
 * removes here, both through this helper — so connect and teardown can't drift.
 * `assertSafeOwnerId` on the owner id + server name (path-security in depth).
 * Because `ownerSegment` is a variable, `check:credential-paths` /
 * `check:workspace-paths` can't flag either literal without false-positiving the
 * other — this is the one audited site both lint headers document.
 */
export function mcpOAuthDir(workDir: string, owner: OAuthOwnerContext, serverName: string): string {
  const ownerSegment = owner.type === "workspace" ? "workspaces" : "users";
  const ownerId = owner.type === "workspace" ? owner.wsId : owner.userId;
  assertSafeOwnerId(ownerId);
  assertSafeOwnerId(serverName);
  return join(workDir, ownerSegment, ownerId, "credentials", "mcp-oauth", serverName);
}

/**
 * Whether an (owner, serverName) has persisted OAuth tokens on disk — i.e. the
 * connector completed its Connect flow at least once. Presence only (survives a
 * pod restart), NOT validity: token expiry / revocation detection is the reauth
 * slice's job. The DCR sibling of `hasPersistedComposioConnection` — used to
 * render "connected" for an authed connector whose source isn't warm in the
 * current pod, so the profile doesn't offer a spurious re-Connect.
 */
export function hasMcpOAuthTokens(
  workDir: string,
  owner: OAuthOwnerContext,
  serverName: string,
): boolean {
  return existsSync(join(mcpOAuthDir(workDir, owner, serverName), "tokens.json"));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Brand metadata sent in the DCR registration so vendors that honor RFC 7591
 * `client_uri` / `logo_uri` render NimbleBrain's homepage link and logo on
 * their consent screen instead of a bare name. Hardcoded to match the
 * likewise-hardcoded "NimbleBrain" in `client_name`; a future white-label
 * effort would make all three configurable together. The logo is the
 * NimbleBrain brand mark from the platform's public asset CDN
 * (`static.nimblebrain.ai`), built by the logos pipeline into the canonical
 * per-brand path. We point at the 128px raster rather than the SVG variant
 * because several OAuth/identity providers refuse to render an SVG `logo_uri`
 * (scriptable-image hardening); the mark is transparent and reads on both
 * light and dark consent screens.
 */
const NIMBLEBRAIN_CLIENT_URI = "https://nimblebrain.ai";
const NIMBLEBRAIN_LOGO_URI = "https://static.nimblebrain.ai/logos/nimblebrain/light-128.png";

/**
 * File-backed OAuthClientProvider scoped to a `(workspace, serverName)`
 * pair. Persistence layout:
 *
 *   <workDir>/workspaces/<wsId>/credentials/mcp-oauth/<serverName>/
 *     ├── client.json    — DCR result (OAuthClientInformationFull)
 *     ├── tokens.json    — OAuthTokens (access + refresh)
 *     └── verifier.json  — PKCE verifier. Overwritten by `saveCodeVerifier`
 *                          on the next flow; explicitly removed only when
 *                          `invalidateCredentials("verifier" | "all")` is
 *                          called. Persists at mode 0o600 between flows;
 *                          read access is gated by the same filesystem
 *                          ACL that protects `tokens.json` next to it.
 *
 * Directory is created with mode 0o700; files are written 0o600 via an
 * atomic rename pattern (write to tmp, chmod, rename). Same discipline as
 * `src/config/workspace-credentials.ts`.
 *
 * For Reboot's `Anonymous` dev OAuth (rbt dev): the authorization URL
 * returned by the server is ALREADY our own callback URL with
 * `?code=anonymous&state=...` embedded (see
 * `reboot/aio/auth/oauth_providers.py:278-281`). We detect the self-target
 * in `redirectToAuthorization` and resolve the pending flow in-process —
 * no HTTP round-trip, no browser. For all other interactive flows, we
 * throw `InteractiveOAuthNotSupportedError` and fail fast.
 */
export class WorkspaceOAuthProvider implements OAuthClientProvider {
  private readonly owner: OAuthOwnerContext;
  private readonly ownerDisplayName?: string;
  private readonly serverName: string;
  /**
   * Single root directory for all credential files for this (owner,
   * server) tuple. `client.json`, `tokens.json`, `verifier.json`, and
   * `identity.json` all live directly under this. The previous
   * `clientDir` / `tokenDir` split (where workspace-shared `client.json`
   * sat outside the per-member token dir) is gone — each owner manages
   * its own DCR registration. For workspace-scope that's still one
   * shared client per workspace; for user-scope it's per-user.
   */
  private readonly dataDir: string;
  private readonly callbackUrl: string;
  /** Canonical form of `callbackUrl` for self-match comparison. */
  private readonly canonicalCallback: string;
  private readonly allowInsecureRemotes: boolean;
  private readonly onInteractiveAuthRequired?: (authorizationUrl: string) => void;
  private readonly onAuthLost?: () => void;
  /** De-dupe guard: a flurry of in-flight tool calls can each throw
   *  UnauthorizedError; the connection should flip to reauth_required once. */
  private authLostNotified = false;
  /**
   * Whether this provider may drive an INTERACTIVE (browser) OAuth flow on the
   * current start attempt — a per-attempt signal, not construction-time.
   *
   * Two provider lifecycles exist, and the flag's default (false) is the safe
   * one for both:
   *   - A BOOT source reuses one provider instance across its initial
   *     auto-start AND every later `HealthMonitor` liveness reconnect. All of
   *     those are background — the flag is never armed — so an interactive
   *     requirement flips to `reauth_required` and fails fast instead of
   *     blocking on a browser flow no one will complete.
   *   - A USER-INITIATED `startAuth` builds a FRESH provider+source (teardown +
   *     rebuild) and arms the flag (via {@link setInteractiveAuthAllowed}) for
   *     that one start only, disarming when it settles.
   *
   * So the only path that ever drives interactive auth is an explicit user
   * reconnect; see {@link BackgroundReauthRequiredError}.
   */
  private interactiveAuthAllowed = false;
  private readonly staticClient?: WorkspaceOAuthProviderOptions["staticClient"];
  private readonly scopes?: string[];
  private readonly additionalAuthorizationParams?: Record<string, string>;
  private readonly abortSignal?: AbortSignal;
  private readonly headlessAuthProbe: boolean;
  /** Canonical origin of the fleet authorizer issuer, or undefined (off). */
  private readonly fleetAuthorizerOrigin?: string;
  /**
   * SDK token-auth hook. Left `undefined` unless the fleet feature is
   * configured (see constructor) — when unset, the SDK runs its own default
   * client authentication and NO fleet code touches the token path. Assigned
   * to {@link fleetTokenAuth} only when `fleetAuthorizerOrigin` is pinned.
   */
  addClientAuthentication?: NonNullable<OAuthClientProvider["addClientAuthentication"]>;
  /** Cached DCR result + tokens to avoid redundant disk reads within a flow. */
  private cachedClientInfo: OAuthClientInformationFull | null = null;
  private cachedTokens: OAuthTokens | null = null;
  /**
   * In-flight DCR coalesce. Set in `clientInformation()` just before it
   * returns `undefined` (which tells the SDK to do DCR). Resolved by the
   * first `saveClientInformation()` call. Concurrent `clientInformation()`
   * callers await this instead of independently returning undefined and
   * causing the SDK to do parallel DCRs whose results overwrite each
   * other's `client.json`. Without coalescing here, the URL we capture in
   * `redirectToAuthorization` can carry one DCR's `client_id` while
   * `client.json` on disk holds another's — vendor issues the code for
   * the URL's client, we exchange with disk's client, vendor returns
   * `invalid_code`. DCR runs BEFORE `state()` in the SDK's auth() flow,
   * so the `pendingFlow`-keyed coalesce (state/verifier/url) can't cover
   * it — DCR needs its own coalesce slot. Cleared after first save.
   */
  private dcrInFlight: Deferred<OAuthClientInformationFull | undefined> | null = null;
  /**
   * The in-flight OAuth flow. Set by `state()` to a provider-local deferred
   * (used by headless flows that resolve in `redirectToAuthorization`). On
   * the interactive branch, `.promise` is REPLACED with the
   * `oauth-flow-registry` promise — that one resolves when the HTTP
   * callback route receives the code from the user's browser.
   * `awaitPendingFlow()` reads `.promise` so it works for both branches
   * uniformly.
   *
   * **Why the extra `verifier` / `urlCaptured` fields**: the MCP SDK's
   * HTTP transport opens a connection with multiple parallel requests
   * (POST initialize, POST initialized notification, GET for SSE stream).
   * When OAuth is required, EACH request 401s and EACH 401 independently
   * triggers `auth()` on this provider, so `state()` / `saveCodeVerifier`
   * / `redirectToAuthorization` run 2–3× concurrently for one logical
   * connect. Without coalescing, each run generates fresh PKCE,
   * overwrites `verifier.json`, and captures a new auth URL — the user
   * opens the FIRST URL, vendor binds the code to challenge #1, exchange
   * uses verifier #N from disk, vendor returns `invalid_code`. These
   * fields let the first concurrent call claim the flow and subsequent
   * calls observe the claim and no-op, so all callers share one PKCE
   * pair and one auth URL. The check-then-claim is synchronous (no
   * `await` between read and assignment), so JS single-threading makes
   * it atomic — no lock primitives needed.
   */
  private pendingFlow: {
    promise: Promise<string>;
    deferred?: Deferred<string>;
    /** First saveCodeVerifier wins; subsequent concurrent calls no-op. */
    verifier?: string;
    /** First redirectToAuthorization wins; subsequent calls throw without re-capturing. */
    urlCaptured?: boolean;
  } | null = null;
  /**
   * The latest state value generated by `state()`. Captured so the
   * interactive branch of `redirectToAuthorization` can register the
   * correct flow with `oauth-flow-registry` even if the SDK adds extra
   * state munging between `state()` and the URL build.
   */
  private currentState: string | null = null;

  constructor(opts: WorkspaceOAuthProviderOptions) {
    this.owner = opts.owner;
    this.ownerDisplayName = opts.ownerDisplayName;
    this.serverName = opts.serverName;
    this.callbackUrl = opts.callbackUrl;
    this.canonicalCallback = canonicalEndpoint(new URL(opts.callbackUrl));
    this.allowInsecureRemotes = opts.allowInsecureRemotes === true;
    this.onInteractiveAuthRequired = opts.onInteractiveAuthRequired;
    this.onAuthLost = opts.onAuthLost;
    this.staticClient = opts.staticClient;
    this.scopes = opts.scopes;
    // Validate at construction so a bad config fails fast — same boundary
    // discipline as `assertSafeOwnerId`.
    validateAdditionalAuthorizationParams(opts.additionalAuthorizationParams);
    this.additionalAuthorizationParams = opts.additionalAuthorizationParams;
    this.abortSignal = opts.abortSignal;
    this.headlessAuthProbe = opts.headlessAuthProbe === true;
    // Pin the fleet authorizer's origin once, at construction — the token-auth
    // hook compares against this and never against caller-supplied values, so a
    // vendor token endpoint can't trick the provider into attaching the assertion.
    this.fleetAuthorizerOrigin = opts.fleetAuthorizerIssuer
      ? originOf(opts.fleetAuthorizerIssuer)
      : undefined;
    if (opts.fleetAuthorizerIssuer && !this.fleetAuthorizerOrigin) {
      // Configured but unparseable: the feature disables itself (fails closed).
      // Warn so a misconfigured NB_FLEET_AUTHORIZER_ISSUER is visible, not silent.
      log.warn(
        `[oauth] fleetAuthorizerIssuer is set but not a valid URL (${opts.fleetAuthorizerIssuer}) — fleet tenant assertion disabled`,
      );
    }
    // Install the token-auth hook ONLY when the fleet feature is active. The SDK
    // uses this hook IN PLACE OF its default client auth, so leaving it undefined
    // for non-fleet (every local / self-host) deployments keeps them on the SDK's
    // own tested path — no fleet code in the token exchange at all.
    if (this.fleetAuthorizerOrigin) {
      this.addClientAuthentication = this.fleetTokenAuth;
    }

    // Resolve the per-owner storage root. Two construction modes:
    //
    //   1. Workspace-scoped owner WITH a `workspaceContext`: the typed
    //      handle owns the workspace's path layout. We assert the context
    //      matches the declared owner (so a caller can't pair a context
    //      bound to ws_A with `owner: {type: "workspace", wsId: ws_B}`)
    //      and derive `dataDir` through `getDataPath` so the workspace
    //      directory structure stays defined in one place.
    //
    //   2. Workspace-scoped owner WITHOUT a context, or user-scoped owner:
    //      legacy `<workDir>/<scope-dir>/<id>/credentials/mcp-oauth/<server>/`
    //      construction. Stays valid until Task 008 migrates the rest of
    //      the construction sites.
    //
    // Owner-id and server-name both pass through `assertSafeOwnerId` in
    // both branches. In the workspaceContext branch the server-name is
    // additionally validated by `getDataPath`'s subpath check; in the
    // legacy branch we explicitly validate it here so the two modes
    // share the same defense (callers pre-validate via
    // `validateServerName` / `slugifyServerName`, but this is the
    // security-critical path component — verify in depth).
    assertSafeOwnerId(opts.serverName);
    if (opts.workspaceContext) {
      if (opts.owner.type !== "workspace") {
        throw new Error(
          "[workspace-oauth-provider] workspaceContext is only valid with workspace-typed owners; " +
            "user-scoped tokens live outside any workspace.",
        );
      }
      if (opts.workspaceContext.workspaceId !== opts.owner.wsId) {
        throw new Error(
          `[workspace-oauth-provider] owner/context mismatch: ` +
            `owner.wsId="${opts.owner.wsId}" but workspaceContext.workspaceId="${opts.workspaceContext.workspaceId}".`,
        );
      }
      assertSafeOwnerId(opts.owner.wsId);
      this.dataDir = opts.workspaceContext.getDataPath("credentials", "mcp-oauth", opts.serverName);
    } else {
      // No `WorkspaceContext` handle — build the owner's mcp-oauth dir through the
      // shared `mcpOAuthDir` helper (workspace-no-context or user owner). Same
      // construction the disconnect teardown uses, so connect and teardown can't
      // drift; the helper carries the `assertSafeOwnerId` checks + the lint story.
      this.dataDir = mcpOAuthDir(opts.workDir, opts.owner, opts.serverName);
    }
  }

  // ── OAuthClientProvider interface ─────────────────────────────────

  /**
   * Arm/disarm interactive (browser) OAuth for the NEXT start attempt. Called
   * by the lifecycle: armed for a user-initiated `startAuth`, disarmed once that
   * start settles. See {@link interactiveAuthAllowed}.
   */
  setInteractiveAuthAllowed(allowed: boolean): void {
    this.interactiveAuthAllowed = allowed;
  }

  get redirectUrl(): string {
    // A registered DCR client is bound to the redirect_uri it was registered
    // with — the AS rejects any other value at /authorize. Honor the stored
    // registration (durable identity) and fall back to the freshly-computed
    // callback only when there is no stored client yet (a fresh DCR registers
    // the current host). Refresh-token grants don't send a redirect_uri at all,
    // so this only matters on the interactive authorization_code path — where,
    // for the cases that actually reach it, the stored value equals callbackUrl
    // (a host-drifted client is re-registered for the current host before its
    // interactive flow runs; see `clientInformation`).
    return this.cachedClientInfo?.redirect_uris?.[0] ?? this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const ownerLabel =
      this.ownerDisplayName ??
      (this.owner.type === "workspace" ? this.owner.wsId : `user:${this.owner.userId}`);
    const meta: OAuthClientMetadata = {
      client_name: `NimbleBrain (${ownerLabel})`,
      client_uri: NIMBLEBRAIN_CLIENT_URI,
      logo_uri: NIMBLEBRAIN_LOGO_URI,
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method:
        this.staticClient?.tokenEndpointAuthMethod ??
        (this.staticClient?.clientSecret ? "client_secret_post" : "none"),
    };
    // Track A: requested OAuth scopes flow into the SDK's authorize URL
    // build via the standard `scope` field on clientMetadata. Joined with
    // a single space per RFC 6749 § 3.3.
    if (this.scopes && this.scopes.length > 0) {
      meta.scope = this.scopes.join(" ");
    }
    return meta;
  }

  state(): string {
    // Coalesce concurrent SDK `auth()` invocations. If a flow is already
    // in progress on this provider (typical: the SDK transport's parallel
    // initialize / initialized / SSE-GET each 401 and each calls auth()),
    // return the SAME state so all callers join one flow instead of
    // generating their own and racing each other's verifier / URL. See
    // `pendingFlow` field comment for the full rationale. Sync — no
    // await between the check and the early return.
    if (this.pendingFlow && this.currentState) {
      return this.currentState;
    }
    const s = randomBytes(32).toString("base64url");
    // Create the deferred early so `awaitPendingFlow()` is safe to call any
    // time after `state()` runs. The headless branch resolves this in
    // `redirectToAuthorization`. The interactive branch replaces the
    // promise with the flow-registry's promise so the HTTP callback route
    // is the resolver.
    const d = deferred<string>();
    this.pendingFlow = { promise: d.promise, deferred: d };
    this.currentState = s;
    return s;
  }

  /**
   * The owner this provider represents. Workspace-scoped: returns the
   * workspace id. User-scoped: returns the user id. Read by the
   * disconnect route + connections snapshot to key per-principal records.
   */
  getOwner(): OAuthOwnerContext {
    return this.owner;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // Track A: pre-registered (static) client takes precedence over
    // any persisted DCR registration. Returning the static info each
    // call (rather than caching it) is fine — the values come from
    // construction-time options, not disk.
    if (this.staticClient) {
      const info: OAuthClientInformationFull = {
        client_id: this.staticClient.clientId,
        redirect_uris: [this.callbackUrl],
        ...(this.staticClient.clientSecret
          ? { client_secret: this.staticClient.clientSecret }
          : {}),
      };
      return info;
    }
    // Candidate registration: prefer the in-memory cache, else read disk. The
    // SAME decision applies to both — a cached client can itself be a
    // previously-honored DRIFTED client (set on the silent/background path
    // below), so the cached path must run the drift/interactive decision too,
    // not blindly return it. (DCR client info is workspace-shared regardless of
    // scope: every member authenticates as the same NimbleBrain OAuth client.)
    const data =
      this.cachedClientInfo ??
      (await this.readJson<OAuthClientInformationFull>(this.dataDir, "client.json"));
    if (data) {
      const resolved = await this.resolveStoredClient(data);
      if (resolved) return resolved;
    }
    // No usable client info on disk → SDK will DCR. Coalesce concurrent
    // callers so only ONE DCR happens; second caller awaits the first's
    // result instead of triggering its own parallel DCR (which would
    // overwrite the first's client.json and decouple URL-captured
    // client_id from disk-stored client_id — root cause of `invalid_code`
    // on the exchange).
    if (this.dcrInFlight) return this.dcrInFlight.promise;
    // Abort guard: if the lifecycle has already aborted (e.g. 15s startAuth
    // timeout fired before we got here), don't claim the slot — return
    // undefined so the SDK's auth() chain fails cleanly rather than seeding
    // a deferred no one will resolve.
    if (this.abortSignal?.aborted) return undefined;
    const d = deferred<OAuthClientInformationFull | undefined>();
    this.dcrInFlight = d;
    // Liveness: tie the deferred to the lifecycle's abortSignal so an
    // abort (timeout, explicit cancel, lifecycle teardown after a failed
    // source.start) unblocks any concurrent `clientInformation()` callers
    // awaiting this DCR. Without this, a first-caller DCR that throws
    // (vendor 4xx, network drop, abort) never calls `saveClientInformation`,
    // and the second concurrent SDK auth() chain on the same provider
    // awaits `dcrInFlight.promise` forever — orphaned promise + reference
    // leak even though the lifecycle's user-facing state has transitioned
    // to dead. Awaiters get `undefined`, which routes them through the
    // SDK's natural failure path (they'll error too, because the broader
    // auth() they're inside is already aborting).
    //
    // CAS on `this.dcrInFlight === d` so a concurrent
    // saveClientInformation that already nulled the slot (success path)
    // can't be undone by a late-firing abort. `{ once: true }` is
    // belt-and-suspenders for the success-then-abort ordering.
    this.abortSignal?.addEventListener(
      "abort",
      () => {
        if (this.dcrInFlight === d) {
          d.resolve(undefined);
          this.dcrInFlight = null;
        }
      },
      { once: true },
    );
    // Detach a no-op .catch so a dangling unresolved promise (caller
    // never calls saveClientInformation AND no abortSignal) doesn't
    // surface as an unhandled rejection. Cleared on first save.
    d.promise.catch(() => {});
    return undefined;
  }

  /**
   * Decide the fate of a stored DCR `client.json`: return it to honor the
   * registration, or `null` to discard it so the SDK re-registers (DCR).
   * Performs the discard side effects (cache clear + unlink) inline.
   */
  private async resolveStoredClient(
    data: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull | null> {
    if (!this.hasUsableRedirectUris(data)) {
      // Structurally corrupt (missing / empty / non-array redirect_uris):
      // unusable at /authorize. Drop it so the SDK re-registers.
      log.warn(
        `[oauth] ${this.serverName} stored client has no usable redirect_uris — discarding so the next flow re-registers`,
      );
      this.cachedClientInfo = null;
      await this.unlinkIfExists(this.dataDir, "client.json");
      return null;
    }
    if (this.redirectUriMatchesCurrent(data) || !this.interactiveAuthAllowed) {
      // The registration matches the current host, OR this is a background /
      // silent context (refresh, boot, liveness reconnect). Honor the stored
      // registration — it's immutable identity, and refresh reuses the
      // `client_id` without a redirect_uri, so a host that has since drifted
      // is irrelevant to keeping the connection alive.
      if (!this.redirectUriMatchesCurrent(data)) {
        log.debug(
          "mcp",
          `[oauth] ${this.serverName} honoring registered redirect_uri ${
            data.redirect_uris?.[0]
          } (current callback ${this.callbackUrl}) — registration is immutable; refresh reuses client_id`,
        );
      }
      this.cachedClientInfo = data;
      return data;
    }
    // Drift on a USER-INITIATED interactive flow: a human is reconnecting
    // and the canonical host changed since this client was registered.
    // Re-register against the current host so the next /authorize's
    // redirect_uri matches the NEW registration AND the session cookie (set
    // on the current host) travels back on the callback leg. The deliberate,
    // consented re-registration the architecture calls for — not the silent
    // discard-on-every-read that caused the crash loop.
    log.warn(
      `[oauth] ${this.serverName} redirect_uri drift on user-initiated reauth (registered=${
        data.redirect_uris?.[0] ?? "<none>"
      }, current=${this.callbackUrl}) — re-registering for the current host`,
    );
    this.cachedClientInfo = null;
    await this.unlinkIfExists(this.dataDir, "client.json");
    return null;
  }

  /**
   * Structural validity of a stored DCR `client.json`: it must carry at least
   * one `redirect_uri` to be usable at /authorize. A missing / empty / non-array
   * value is corrupt on-disk state — unusable, so the caller re-registers.
   *
   * This intentionally does NOT compare against the current `callbackUrl`: a
   * host that drifted from the registered value is NOT a reason to discard a
   * valid registration. Silent refresh reuses the `client_id` without sending a
   * redirect_uri, so a drifted client stays fully usable for keeping the
   * connection alive. Host-drift handling lives in `clientInformation` (honor on
   * the silent/background path; re-register only on a user-initiated interactive
   * reauth). See {@link redirectUriMatchesCurrent}.
   */
  private hasUsableRedirectUris(info: OAuthClientInformationFull): boolean {
    const uris = info.redirect_uris;
    return Array.isArray(uris) && uris.length > 0;
  }

  /**
   * Whether the stored client's registered `redirect_uri` matches this
   * provider's current `callbackUrl`, compared canonically (trailing slash,
   * default port, host case tolerated). Detects host drift — used for logging
   * and to decide whether a USER-INITIATED interactive reauth must re-register
   * against the current host.
   */
  private redirectUriMatchesCurrent(info: OAuthClientInformationFull): boolean {
    const uris = info.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) return false;
    return uris.some((u) => {
      try {
        return canonicalEndpoint(new URL(u)) === this.canonicalCallback;
      } catch {
        return false;
      }
    });
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    // Track A: pre-registered clients are immutable from the SDK's
    // perspective — DCR is the only path that calls saveClientInformation,
    // and we don't run DCR when staticClient is set. No-op here so a
    // stray SDK call doesn't overwrite the static client to disk.
    if (this.staticClient) {
      log.debug(
        "mcp",
        `[oauth] ${this.serverName} saveClientInformation skipped — using pre-registered static client`,
      );
      return;
    }
    // Coalesce concurrent DCR results. The MCP SDK's parallel transport
    // requests each independently 401, trigger their own auth() flow, and
    // do their own DCR — N concurrent saveClientInformation calls follow,
    // each with a DIFFERENT freshly-registered client_id. Without
    // first-writer-wins, the last save overwrites disk + cache, but the
    // URL captured in `redirectToAuthorization` (which the user opens) was
    // built using a DIFFERENT call's client_id. Vendor issues the code
    // for URL-client, we exchange with disk-client, vendor returns
    // `invalid_code`. First-wins ensures both the disk and the captured
    // URL use the SAME client_id (the first DCR's), because subsequent
    // SDK calls' `clientInformation()` returns the first-coalesced value
    // (via `dcrInFlight`) instead of triggering a parallel DCR. Sync
    // check-then-claim — JS single-threading makes it atomic.
    const isFirstSave = !this.cachedClientInfo;
    if (isFirstSave) {
      this.cachedClientInfo = info;
      await this.writeJson(this.dataDir, "client.json", info);
    }
    // Release any callers blocked in `clientInformation()` awaiting this
    // DCR. They receive the first save's info (whether we wrote it just
    // now or another caller had already populated `cachedClientInfo`),
    // skip their own DCR, and proceed with the same client_id.
    if (this.dcrInFlight) {
      this.dcrInFlight.resolve(this.cachedClientInfo ?? info);
      this.dcrInFlight = null;
    }
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.cachedTokens) return this.cachedTokens;
    const data = await this.readJson<OAuthTokens>(this.dataDir, "tokens.json");
    if (data) this.cachedTokens = data;
    return data ?? undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.cachedTokens = tokens;
    // Fresh tokens landed — a subsequent auth loss is a NEW episode, so
    // re-arm the one-shot `notifyAuthLost` guard. Without this, a connection
    // that went reauth_required, reconnected, then expired again would never
    // re-signal (the guard stays latched for the provider's lifetime).
    this.authLostNotified = false;
    await this.writeJson(this.dataDir, "tokens.json", tokens);

    // Connector OAuth health — redacted (booleans + lifetime only, never token
    // values). A token response carrying no refresh_token means the connection
    // CANNOT refresh: it dies at access-token expiry and needs a full reconnect
    // every time. That silently degrades scheduled automations (a daily run
    // lands after the access token has expired → dead connector). The usual
    // cause is a vendor that gates offline access behind a non-standard param
    // (Dropbox's `token_access_type=offline`, Google's `access_type=offline`)
    // that the connector entry didn't set. The MCP SDK's `refreshAuthorization`
    // (not a method on this class) carries a prior refresh_token forward — it
    // returns `{ refresh_token: <prior>, ...newTokens }` — so a present field
    // here means the connection stays refreshable across refreshes, and the warn
    // fires only for a genuinely non-refreshable connection, at connect time, by
    // name.
    const hasRefreshToken =
      typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0;
    if (hasRefreshToken) {
      log.debug(
        "mcp",
        `[oauth] ${this.serverName} tokens saved: refreshable=true expires_in=${tokens.expires_in ?? "?"}`,
      );
    } else {
      log.warn(
        `[oauth] ${this.serverName} token exchange returned NO refresh_token ` +
          `(expires_in=${tokens.expires_in ?? "?"}) — this connection cannot refresh and will ` +
          `require a manual reconnect at access-token expiry. If the vendor gates offline ` +
          `access behind a param (e.g. token_access_type=offline / access_type=offline), set ` +
          `it on the connector's additionalAuthorizationParams.`,
      );
    }

    // OIDC identity capture (best-effort). When the AS returns an
    // id_token alongside the tokens — Google, Microsoft, and Zoom all
    // do; many other OAuth 2.1 servers do too — parse the JWT payload
    // and store the relevant identity claims to identity.json so the
    // Connections page can show "Connected as <email>". No signature
    // verification: TLS to the token endpoint is the trust anchor for
    // this token, and we treat the result as informational (not used
    // for access decisions). Failures here are silent — auth still
    // succeeds; the UI just doesn't get a display name.
    const idToken = (tokens as { id_token?: unknown }).id_token;
    if (typeof idToken === "string" && idToken.length > 0) {
      try {
        const claims = parseIdTokenClaims(idToken);
        if (claims) {
          await this.writeJson(this.dataDir, "identity.json", claims);
        }
      } catch (err) {
        log.debug(
          "mcp",
          `[oauth] ${this.serverName} id_token parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Signal that an established connection lost its authorization mid-session
   * (a tool call threw `UnauthorizedError` because the persisted refresh token
   * was rejected). Fires the `onAuthLost` callback once per auth episode —
   * the wiring records `running → reauth_required`. De-duped because a burst of
   * concurrent tool calls can each surface the same failure; `saveTokens`
   * re-arms it after a successful reconnect. Best-effort: a throwing callback
   * is swallowed so it can never turn a tool-call failure into a worse one.
   */
  notifyAuthLost(): void {
    if (this.authLostNotified) return;
    this.authLostNotified = true;
    // Operator-visible, redacted: the credential was rejected and the
    // connection is flipping to reauth_required. The flip is otherwise only an
    // SSE event for the UI banner — this is the Loki-queryable signal. (A
    // Prometheus counter + alert on this is the tracked follow-up.)
    log.warn(
      `[oauth] ${this.serverName} authorization lost — connection flipping to reauth_required`,
    );
    try {
      this.onAuthLost?.();
    } catch (err) {
      log.debug(
        "mcp",
        `[oauth] onAuthLost callback threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Read the captured OIDC identity claims for this principal. Returns
   * `null` when no `identity.json` exists (no id_token was issued, or
   * the bundle predates id_token capture). Used by the Connections
   * page to show "Connected as <email>".
   */
  async identity(): Promise<{ sub?: string; email?: string; name?: string } | null> {
    return await this.readJson<{ sub?: string; email?: string; name?: string }>(
      this.dataDir,
      "identity.json",
    );
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    // Coalesce concurrent SDK `auth()` invocations. The SDK calls this
    // after `startAuthorization` generates a fresh PKCE pair — if N
    // concurrent auth() calls run on this provider, each calls us with
    // its own verifier and the last writer to disk wins. The user has
    // already been committed to the FIRST flow's auth URL (returned by
    // the first state() / redirectToAuthorization), so its challenge is
    // what the vendor stored. Overwriting verifier.json with a later
    // call's value desynchronizes verifier from challenge → vendor
    // returns `invalid_code` on exchange.
    //
    // Claim the slot synchronously (no `await` between check and set) so
    // JS single-threading makes the first-writer-wins atomic. The disk
    // write that follows is best-effort — even if it races with another
    // tick, the in-memory claim is the source of truth for which
    // verifier is part of this flow.
    if (this.pendingFlow) {
      if (this.pendingFlow.verifier) return; // already claimed by an earlier concurrent auth()
      this.pendingFlow.verifier = codeVerifier;
    }
    await this.writeJson(this.dataDir, "verifier.json", { codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const data = await this.readJson<{ codeVerifier: string }>(this.dataDir, "verifier.json");
    if (!data) throw new Error("PKCE code verifier missing — OAuth flow corrupted");
    return data.codeVerifier;
  }

  /**
   * Fleet token-auth hook. Installed as `addClientAuthentication` ONLY when the
   * fleet feature is configured (see constructor) — never on a local / self-host
   * deployment. The SDK calls `addClientAuthentication` IN PLACE OF its built-in
   * client authentication (auth.js executeTokenRequest:
   * `if (addClientAuthentication) … else <default> …`), so once installed this
   * provider owns client auth on EVERY token endpoint it talks to. We therefore:
   *   1. always apply the standard OAuth 2.1 client auth the SDK would have
   *      (client_id / client_secret per the negotiated method), then
   *   2. additionally present the fleet tenant assertion — but ONLY to the
   *      fleet authorizer's token endpoint.
   * Because it's only installed in fleet deployments, none of this runs (and the
   * {@link applyClientAuthentication} SDK-mirror carries no drift risk) for the
   * local path.
   *
   * The assertion binds this tenant's identity to the flow's PKCE
   * `code_challenge` (= SHA256(code_verifier)); the authorizer verifies the MAC
   * and mints the proven `tenant_id`. A tenant-key signature must never leak to
   * a vendor token endpoint, hence the origin guard.
   *
   * A bound arrow property, NOT a prototype method: the SDK's `auth()` flow
   * destructures it off the provider
   * (`addClientAuthentication: provider.addClientAuthentication`) and invokes it
   * unbound, so a plain method would lose `this`.
   */
  private readonly fleetTokenAuth = async (
    headers: Headers,
    params: URLSearchParams,
    url: string | URL,
    metadata?: AuthorizationServerMetadata,
  ): Promise<void> => {
    // (1) Reproduce the SDK's default client authentication. Without this, the
    // token request would carry no client_id/secret and every exchange fails.
    const clientInformation = await this.clientInformation();
    if (clientInformation) {
      const supported = metadata?.token_endpoint_auth_methods_supported ?? [];
      applyClientAuthentication(
        selectClientAuthMethod(clientInformation, supported),
        clientInformation,
        headers,
        params,
      );
    }

    // (2) Fleet tenant assertion — only for the fleet authorizer's endpoint.
    if (!this.fleetAuthorizerOrigin) return;
    // The token endpoint we're POSTing to must belong to the fleet authorizer.
    if (originOf(url) !== this.fleetAuthorizerOrigin) return;

    // `inner` binds the assertion to THIS PKCE flow. The token request already
    // carries `code_verifier`; the bound challenge is its S256 hash, which is
    // exactly what the authorizer stored at /authorize. The SDK also invokes
    // this hook on the refresh grant, which has no `code_verifier` — so refresh
    // requests are intentionally left unasserted (PKCE binding can't exist on
    // refresh). The fleet authorizer must not require an assertion on refresh.
    const verifier = params.get("code_verifier");
    if (!verifier) return;
    const inner = createHash("sha256").update(verifier).digest("base64url");

    const assertion = buildTenantAssertion({ inner });
    if (assertion) params.set("tenant_assertion", assertion);
  };

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.pendingFlow) {
      throw new Error(
        "[workspace-oauth-provider] redirectToAuthorization called without an active flow",
      );
    }
    // Coalesce concurrent SDK `auth()` invocations. If an earlier concurrent
    // call already captured a URL and registered the flow with the
    // oauth-flow-registry, this call MUST NOT capture a different URL.
    if (this.pendingFlow.urlCaptured) {
      throw new UnauthorizedError(
        `Interactive OAuth already in progress for ${this.serverName} (concurrent auth() call coalesced).`,
      );
    }
    // PKCE coupling: only the auth() chain whose captured URL matches the
    // claimed verifier may proceed (see assertUrlPkceMatchesVerifier).
    this.assertUrlPkceMatchesVerifier(url);
    // Track A: append operator-supplied additional authorize params
    // (e.g. Google's access_type=offline + prompt=consent for refresh-
    // token issuance). Reserved keys are blocked at construction so we
    // can't accidentally overwrite client_id / state / PKCE here.
    if (this.additionalAuthorizationParams) {
      for (const [k, v] of Object.entries(this.additionalAuthorizationParams)) {
        url.searchParams.set(k, v);
      }
    }
    // Claim the URL-capture slot synchronously, BEFORE any await. The
    // headless probe loop and interactive branch below both `await`, so
    // without this claim two concurrent calls could both reach the
    // capture phase and the second would clobber the first's state.
    this.pendingFlow.urlCaptured = true;
    // Local deferred for the headless branch. The interactive branch
    // doesn't use this — it swaps `pendingFlow.promise` for the flow
    // registry's promise instead.
    const d = this.pendingFlow.deferred;

    // Headless probe: follow the authorize redirect chain server-side and, if
    // it lands on our own callback with a code, resolve the flow in-process (no
    // browser). Returns true only for that headless-resolved case. Real
    // interactive providers never land on our callback, so this returns false
    // and we fall through to the interactive branch. See probeHeadlessRedirect.
    if (await this.probeHeadlessRedirect(url, d)) return;

    // Background/liveness gate. If this start attempt is NOT user-initiated
    // (boot auto-start or a HealthMonitor liveness reconnect), there is no user
    // to complete a browser flow. Registering an `oauth-flow-registry` flow here
    // would block `start()` on `awaitPendingFlow()` for the full 15-minute flow
    // TTL and then fail — the headless-reconnect crash loop. Flip the connection
    // to `reauth_required` (one-shot via `notifyAuthLost`) and fail fast; the
    // UI's Reconnect runs `startAuth`, which arms interactive for that attempt.
    if (!this.interactiveAuthAllowed) {
      log.debug(
        "mcp",
        `[oauth] ${this.serverName} interactive auth required but no user-initiated flow active — surfacing reauth_required (no headless block)`,
      );
      this.notifyAuthLost();
      const err = new BackgroundReauthRequiredError(this.serverName);
      // Settle the pending flow so any concurrently-coalesced auth() chain
      // awaiting `awaitPendingFlow()` rejects too instead of hanging. The extra
      // `.catch` swallows the no-awaiter case (the common one: start() fails
      // fast on this error and never calls awaitPendingFlow), so the deliberate
      // rejection can't surface as an unhandled rejection.
      this.pendingFlow.promise.catch(() => {});
      d?.reject(err);
      throw err;
    }

    // Interactive branch: real browser redirect required. Register the
    // flow with `oauth-flow-registry` so the HTTP callback route can
    // resolve it once the user completes the authorization. Replace the
    // provider-local promise with the registry's promise so
    // `awaitPendingFlow()` returns the registry-resolved code.
    //
    // Extract `state` from the authorize URL the SDK built. The SDK
    // takes our `state()` value and embeds it as `?state=...`; pulling
    // from the URL keeps us robust if the SDK ever munges the value
    // (e.g., wraps it for its own bookkeeping).
    const stateParam = url.searchParams.get("state") ?? this.currentState;
    if (!stateParam) {
      const err = new Error(
        "[workspace-oauth-provider] interactive flow requested but no state parameter in authorize URL",
      );
      d?.reject(err);
      throw err;
    }

    log.debug(
      "mcp",
      `[oauth] interactive flow: ${this.serverName} registering state=${stateParam.slice(0, 8)}… url=${url.origin}…`,
    );

    // The flow carries its owner so the callback lands the user back on the
    // right page — a workspace connector's settings page vs the user's profile.
    const flowOwner: FlowOwner =
      this.owner.type === "workspace"
        ? { kind: "workspace", wsId: this.owner.wsId }
        : { kind: "user", userId: this.owner.userId };
    const registryPromise = registerInteractiveFlow(stateParam, flowOwner, this.serverName);
    // Swap the promise to the registry's (which resolves on HTTP callback
    // delivering the code) and drop the headless-branch deferred (no longer
    // applicable on the interactive path). MUTATE rather than replace the
    // object — the existing flow's claim bits (`verifier`, `urlCaptured`)
    // belong to the same single in-flight flow and must remain observable
    // to any concurrent `saveCodeVerifier` / `redirectToAuthorization` that
    // arrives after this point. Replacement loses them and re-opens the
    // race this file is built to prevent.
    this.pendingFlow.promise = registryPromise;
    this.pendingFlow.deferred = undefined;

    // Notify the lifecycle / UI so the bundle transitions to pending_auth and
    // the banner appears (best-effort — see notifyInteractiveAuthRequired). The
    // registry registration above already lets the callback handler resolve the
    // flow even if the lifecycle notification path is broken.
    this.notifyInteractiveAuthRequired(url);

    // Throw the SDK's own UnauthorizedError so `Client.connect()` aborts
    // cleanly — `McpSource.start()` catches this and awaits
    // `awaitPendingFlow()`, which now returns the registry promise.
    throw new UnauthorizedError(
      `Interactive OAuth required for ${this.serverName} — pending user authorization at ${url.origin}.`,
    );
  }

  /**
   * PKCE coupling guard. `saveCodeVerifier` and `redirectToAuthorization` are
   * decoupled in time — different concurrent auth() chains can win each race
   * independently. If chain A's verifier is on disk but chain B's URL captures
   * (different `code_challenge`), the user opens URL_B → vendor binds the code
   * to challenge_B → exchange POSTs verifier_A → vendor rejects. To preserve
   * PKCE correctness we let ONLY the chain whose verifier matches this URL's
   * challenge proceed to capture; other chains throw and let the matching chain
   * win. The matching chain is uniquely identified: the saveCodeVerifier winner
   * stored its verifier in `pendingFlow.verifier`, and only that chain's
   * startAuthorization output (URL + verifier from one closure) has the matching
   * SHA256(verifier) == code_challenge relation.
   */
  private assertUrlPkceMatchesVerifier(url: URL): void {
    const verifier = this.pendingFlow?.verifier;
    if (!verifier) return;
    // Gate on S256 — the SHA256 derivation only applies to
    // `code_challenge_method=S256`. For `plain` (rare in modern OAuth, not used
    // by the MCP SDK today) the challenge equals the verifier and the SHA256
    // comparison would falsely reject every chain. Defensive against a future
    // SDK / vendor that ever surfaces a non-S256 flow through this provider.
    if (url.searchParams.get("code_challenge_method") !== "S256") return;
    const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
    const urlChallenge = url.searchParams.get("code_challenge");
    if (urlChallenge && urlChallenge !== expectedChallenge) {
      // This auth() chain's URL is built from a DIFFERENT verifier than the one
      // we kept on disk. Throw without capturing — wait for the matching chain's
      // redirectToAuthorization to win the capture.
      throw new UnauthorizedError(
        `Interactive OAuth: this chain's PKCE doesn't match the claimed verifier — deferring to matching chain.`,
      );
    }
  }

  /**
   * Follow the authorize redirect chain hop-by-hop for a HEADLESS provider.
   * Headless providers (Reboot `Anonymous`, client_credentials-style flows)
   * eventually 302 to our own callback with the authorization code already in
   * the URL, at which point we resolve the flow's deferred and return `true`.
   * Reboot specifically does two hops: /__/oauth/authorize → /__/oauth/callback
   * → our callback.
   *
   * We use manual redirect handling (not fetch's default follow) so we can
   * inspect every Location, stop as soon as one targets our callback, and avoid
   * actually dispatching a request to our own server (which would tangle our own
   * HTTP event loop into the probe).
   *
   * Headless-only (see `headlessAuthProbe`): a no-op returning `false` unless
   * that flag is set. A standard interactive provider must NOT be probed
   * server-side — fetching `/authorize` ourselves spins up a vendor
   * authorization session bound to our PKCE challenge before the user acts,
   * which makes the vendor reject the user's real code at exchange
   * (`invalid_code`) or strand the flow. Real interactive providers (Granola,
   * Claude.ai hosted) also redirect to a login page on a different origin — the
   * loop never lands on our callback — so we return `false` and the caller falls
   * through to the interactive branch. Throws (rejecting `d`) for authz-server
   * errors and SSRF blocks; swallows network failures and returns `false`.
   */
  private async probeHeadlessRedirect(url: URL, d: Deferred<string> | undefined): Promise<boolean> {
    if (!this.headlessAuthProbe) return false;
    const MAX_HOPS = 10;
    let current = url;
    try {
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        const outcome = await this.followHeadlessHop(current, d, hop);
        if (outcome.resolved) return true;
        if (!outcome.next) break;
        current = outcome.next;
      }
    } catch (probeErr) {
      // Rethrow our own explicit errors (authz server error, SSRF block) so
      // callers see the real cause instead of the generic interactive-branch
      // surface. Swallow network failures and fall through to the interactive
      // branch.
      if (probeErr instanceof Error && probeErr.message.includes("[workspace-oauth-provider]")) {
        d?.reject(probeErr);
        throw probeErr;
      }
      log.debug("mcp", `[oauth] ${this.serverName} redirect probe failed: ${String(probeErr)}`);
    }
    return false;
  }

  /**
   * Follow one hop of the headless authorize-redirect chain. Returns
   * `{ resolved: true }` when it landed on our callback with a code (flow's `d`
   * already resolved), `{ next }` to keep probing that Location, or `{}` to stop
   * probing (non-redirect response, no Location, or our callback without a
   * code). Throws (with our marker prefix) on SSRF block or authz-server error.
   */
  private async followHeadlessHop(
    current: URL,
    d: Deferred<string> | undefined,
    hop: number,
  ): Promise<{ resolved?: boolean; next?: URL }> {
    this.validateProbeHop(current);
    // Honor lifecycle's timeout: when the controller aborts, the in-flight TCP
    // read terminates with an AbortError instead of running its full network
    // timeout in the background.
    const res = await fetch(current.toString(), {
      redirect: "manual",
      ...(this.abortSignal ? { signal: this.abortSignal } : {}),
    });
    // Non-redirect response — provider sent us a login page (200) or an error
    // (4xx/5xx). Not headless.
    if (res.status < 300 || res.status >= 400) return {};
    const location = res.headers.get("location");
    if (!location) return {};
    const next = new URL(location, current);
    if (canonicalEndpoint(next) !== this.canonicalCallback) return { next };
    return this.consumeHeadlessCallback(next, d, hop) ? { resolved: true } : {};
  }

  /**
   * SSRF-validate one authorize-chain hop. Validates EVERY hop (including the
   * initial URL the server handed us), not just the configured bundle URL: the
   * authorize URL and every Location header are attacker-controlled — a
   * compromised remote MCP server could otherwise use our fetch() as an
   * internal-network probe tool (AWS IMDS, RFC1918 admin panels, loopback
   * services). Rethrows with our marker prefix so the probe's outer catch
   * rethrows instead of silently falling through to the interactive branch.
   */
  private validateProbeHop(current: URL): void {
    try {
      validateBundleUrl(current, { allowInsecure: this.allowInsecureRemotes });
    } catch (err) {
      throw new Error(
        `[workspace-oauth-provider] SSRF block on ${current.toString()}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Handle a redirect hop that landed on our own callback URL. Resolves the
   * flow's deferred and returns `true` when a `code` is present; throws
   * (rejecting `d`) on an `error` param; returns `false` when neither is present
   * (caller stops probing).
   */
  private consumeHeadlessCallback(
    next: URL,
    d: Deferred<string> | undefined,
    hop: number,
  ): boolean {
    const code = next.searchParams.get("code");
    const errParam = next.searchParams.get("error");
    if (code) {
      log.debug(
        "mcp",
        `[oauth] headless flow: ${this.serverName} got code=${code.slice(0, 8)}… after ${hop + 1} hop(s)`,
      );
      d?.resolve(code);
      return true;
    }
    if (errParam) {
      const err = new Error(
        `[workspace-oauth-provider] authorization server returned error: ${errParam}`,
      );
      d?.reject(err);
      throw err;
    }
    return false;
  }

  /**
   * Fire the `onInteractiveAuthRequired` callback so the lifecycle / UI can
   * transition the bundle to pending_auth. Best-effort: a throwing receiver must
   * not break the OAuth dance, so errors are logged and swallowed.
   */
  private notifyInteractiveAuthRequired(url: URL): void {
    if (!this.onInteractiveAuthRequired) return;
    try {
      this.onInteractiveAuthRequired(url.toString());
    } catch (cbErr) {
      log.warn(
        `[oauth] onInteractiveAuthRequired callback threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
      );
    }
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "client") {
      this.cachedClientInfo = null;
      await this.unlinkIfExists(this.dataDir, "client.json");
      // Release any in-flight DCR coalesce so the SDK's post-invalidate
      // retry path can do a FRESH DCR. Without this, the retry's
      // clientInformation() would await the stale `dcrInFlight` promise
      // forever (it was meant to resolve from saveClientInformation, but
      // that already happened with the now-invalidated client).
      if (this.dcrInFlight) {
        this.dcrInFlight.resolve(undefined);
        this.dcrInFlight = null;
      }
    }
    if (scope === "all" || scope === "tokens") {
      this.cachedTokens = null;
      await this.unlinkIfExists(this.dataDir, "tokens.json");
      // identity.json is bound 1:1 with tokens — when tokens go, the
      // captured identity is no longer meaningful (the user might
      // re-auth as someone else next time).
      await this.unlinkIfExists(this.dataDir, "identity.json");
    }
    if (scope === "all" || scope === "verifier") {
      await this.unlinkIfExists(this.dataDir, "verifier.json");
    }
    // 'discovery' is SDK-internal metadata; we don't persist it.
  }

  // ── Extensions used by McpSource.start() ──────────────────────────

  /**
   * Await the in-flight authorization to yield an authorization code.
   * Called by `McpSource.start()` after catching `UnauthorizedError` so it
   * can then call `transport.finishAuth(code)` and retry `connect()`.
   *
   * Fails fast if the flow was rejected (e.g., interactive OAuth).
   */
  async awaitPendingFlow(): Promise<string> {
    if (!this.pendingFlow) {
      throw new Error(
        "[workspace-oauth-provider] awaitPendingFlow called with no active flow — " +
          "redirectToAuthorization was never invoked on this provider",
      );
    }
    return this.pendingFlow.promise;
  }

  /**
   * Best-effort revoke the persisted tokens at the upstream
   * authorization server (RFC 7009) and delete them locally.
   *
   * Order of operations:
   *
   *   1. Read tokens off disk + read DCR client info (or static client
   *      from `oauthClient` / cached in-memory).
   *   2. Discover the AS's `revocation_endpoint` via the well-known
   *      OAuth metadata path: `<server-origin>/.well-known/oauth-authorization-server`.
   *      We bind discovery to the bundle URL's origin since that's the
   *      only origin we know belongs to this server; servers that put
   *      their AS at a different origin can declare it via metadata
   *      but we don't currently support cross-origin discovery (rare
   *      in practice for the vendors we care about).
   *   3. POST `token` + `client_id` (+ `client_secret` for static
   *      clients with secret-based auth) to the revocation_endpoint.
   *      RFC 7009 says revoke both access + refresh in one call when
   *      revoking a refresh token (servers SHOULD cascade); we revoke
   *      whichever we have, refresh first when present.
   *   4. Delete tokens.json + verifier.json + identity.json locally.
   *
   * Returns a structured result indicating which steps succeeded —
   * callers should log but not fail-the-whole-disconnect on partial
   * success: the local files are gone, the upstream may have stale
   * refresh tokens for at most their natural expiry. Best-effort is
   * the right discipline here.
   *
   * `bundleUrl` is the bundle's MCP endpoint URL — used as the origin
   * for OAuth metadata discovery. `fetchImpl` is injectable for tests.
   */
  async revokeAndDeleteTokens(opts: { bundleUrl: string; fetchImpl?: typeof fetch }): Promise<{
    revoked: { access?: boolean; refresh?: boolean };
    deletedLocal: boolean;
    error?: string;
  }> {
    const baseFetcher = opts.fetchImpl ?? fetch;
    // Thread `this.abortSignal` into every revoke-path fetch (AS metadata
    // discovery + RFC 7009 POSTs) so an unresponsive server's TCP read
    // can be cut by the same controller that guards the redirect probe.
    // No caller in this path sets its own `init.signal`, so the spread
    // is unambiguous.
    const signal = this.abortSignal;
    const fetcher: typeof fetch = signal
      ? (((input, init) => baseFetcher(input, { ...init, signal })) as typeof fetch)
      : baseFetcher;
    const tokens = await this.tokens();
    const clientInfo = await this.clientInformation();
    const result: {
      revoked: { access?: boolean; refresh?: boolean };
      deletedLocal: boolean;
      error?: string;
    } = {
      revoked: {},
      deletedLocal: false,
    };

    // No tokens to revoke — just clear local state.
    if (!tokens) {
      await this.invalidateCredentials("tokens");
      await this.invalidateCredentials("verifier");
      result.deletedLocal = true;
      return result;
    }

    // Discover the revocation endpoint (best-effort — undefined when the server
    // advertises none, in which case there's nothing to revoke upstream).
    const revocationEndpoint = await this.discoverRevocationEndpoint(fetcher, opts.bundleUrl);

    if (!clientInfo) {
      // `clientInformation()` returned undefined despite tokens being
      // present — the canonical cause is drift detection unlinking
      // `client.json` on this very call. Without a client_id we can't
      // authenticate the RFC 7009 POST, so we skip upstream revoke and
      // fall through to local cleanup. AS-side tokens stay valid until
      // their natural expiry. Logged so operators reading audit trails
      // understand why a particular disconnect didn't revoke.
      log.warn(
        `[oauth] ${this.serverName} skipping upstream revoke — no client info available ` +
          `(likely DCR redirect_uri drift just discarded client.json). Local tokens still cleaned.`,
      );
    }

    if (revocationEndpoint && clientInfo) {
      await this.revokeTokenPair(fetcher, revocationEndpoint, tokens, clientInfo, result);
    }

    // Always clear local state regardless of upstream revocation result.
    // `all` is broader than the literal "tokens" the method name implies,
    // and intentional: leaving the cached DCR `client.json` behind across
    // a deliberate disconnect/reconnect is the well-trodden bug path. If the
    // tenant's canonical origin changes between a disconnect and the next
    // reconnect (e.g. a custom domain is added so `publicOrigin()` /
    // `NB_PLATFORM_HOST` resolves to a different host), the AS still has the
    // old `redirect_uri` registered to the cached `client_id`, and the next
    // /authorize comes back as `Invalid redirect_uri`. Re-registering on the
    // next reconnect costs one DCR roundtrip — cheap insurance against a
    // confusing prod failure mode. (Note: this is the *deliberate disconnect*
    // path; a passive host drift does NOT discard the client — see
    // `clientInformation`, which honors the stored registration on the
    // silent/background path and only re-registers on user-initiated reauth.)
    await this.invalidateCredentials("all");
    result.deletedLocal = true;
    return result;
  }

  /**
   * Discover the AS `revocation_endpoint` for a bundle. Best-effort — returns
   * undefined when the server advertises none or on any network error.
   *
   * Discovery order:
   *   1. RFC 9728 Protected Resource Metadata at
   *      `<bundleOrigin>/.well-known/oauth-protected-resource`. This lists
   *      `authorization_servers[]` whose origins host the AS metadata. Required
   *      for vendors where the AS lives at a different origin than the resource
   *      (Google: AS at `oauth2.googleapis.com`, bundle at
   *      `gmailmcp.googleapis.com`; Microsoft: AS at `login.microsoftonline.com`).
   *   2. RFC 8414 fallback at
   *      `<bundleOrigin>/.well-known/oauth-authorization-server` for vendors
   *      that co-locate the AS with the resource (Granola, Notion, HubSpot).
   */
  private async discoverRevocationEndpoint(
    fetcher: typeof fetch,
    bundleUrl: string,
  ): Promise<string | undefined> {
    try {
      const bundleOrigin = new URL(bundleUrl).origin;
      const asOrigins = await discoverAuthorizationServerOrigins(
        fetcher,
        bundleOrigin,
        this.allowInsecureRemotes,
      );
      // Try each AS in order. First one that advertises a usable
      // revocation_endpoint (a well-formed URL that passes SSRF/scheme
      // validation) wins. An AS whose endpoint is malformed, relative, or
      // rejected yields undefined and we fall through to the next origin.
      for (const asOrigin of asOrigins) {
        const endpoint = await this.fetchRevocationEndpoint(fetcher, asOrigin);
        if (endpoint !== undefined) return endpoint;
      }
    } catch (err) {
      log.debug(
        "mcp",
        `[oauth] ${this.serverName} revocation discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return undefined;
  }

  /**
   * Fetch one AS's RFC 8414 metadata and return its `revocation_endpoint`, or
   * undefined (SSRF-blocked, unreachable, non-2xx, or not advertised).
   */
  private async fetchRevocationEndpoint(
    fetcher: typeof fetch,
    asOrigin: string,
  ): Promise<string | undefined> {
    const metadataUrl = `${asOrigin}/.well-known/oauth-authorization-server`;
    try {
      validateBundleUrl(new URL(metadataUrl), {
        allowInsecure: this.allowInsecureRemotes,
      });
      const res = await fetcher(metadataUrl);
      if (!res.ok) return undefined;
      const meta = (await res.json()) as { revocation_endpoint?: unknown };
      if (typeof meta.revocation_endpoint === "string") {
        // The endpoint is a URL lifted from the (attacker-influenceable) AS
        // metadata *body* — an independent target from the metadata URL
        // validated above, and one we POST the refresh token + client_secret
        // to. Re-validate it against the same SSRF/scheme rules so a
        // malicious server can't point revocation at a private/metadata
        // address or a non-HTTPS host. A malformed or rejected endpoint
        // throws into the catch below → treated as "none advertised", which
        // matches this method's best-effort contract (local cleanup still
        // runs; upstream tokens lapse at their natural expiry).
        validateBundleUrl(new URL(meta.revocation_endpoint), {
          allowInsecure: this.allowInsecureRemotes,
        });
        return meta.revocation_endpoint;
      }
    } catch (innerErr) {
      log.debug(
        "mcp",
        `[oauth] ${this.serverName} AS metadata fetch failed at ${metadataUrl}: ${
          innerErr instanceof Error ? innerErr.message : String(innerErr)
        }`,
      );
    }
    return undefined;
  }

  /**
   * Revoke the refresh + access tokens at the endpoint (RFC 7009), recording
   * per-token outcomes onto `result`. Revokes the refresh token first because
   * it's the longer-lived credential — even if access-token revocation races a
   * separate caller's request, the AS won't issue a fresh one once the RT is
   * gone. Never throws: a revocation error is logged and stashed on
   * `result.error` so disconnect continues to local cleanup.
   */
  private async revokeTokenPair(
    fetcher: typeof fetch,
    endpoint: string,
    tokens: OAuthTokens,
    clientInfo: OAuthClientInformationMixed,
    result: { revoked: { access?: boolean; refresh?: boolean }; error?: string },
  ): Promise<void> {
    try {
      if (tokens.refresh_token) {
        result.revoked.refresh = await postRevoke(
          fetcher,
          endpoint,
          tokens.refresh_token,
          "refresh_token",
          clientInfo,
        );
      }
      if (tokens.access_token) {
        result.revoked.access = await postRevoke(
          fetcher,
          endpoint,
          tokens.access_token,
          "access_token",
          clientInfo,
        );
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      log.warn(
        `[oauth] ${this.serverName} revocation failed: ${result.error} (continuing with local cleanup)`,
      );
    }
  }

  // ── File I/O helpers ──────────────────────────────────────────────
  //
  // All disk operations are parameterized by directory so the same atomic-
  // write discipline serves both the workspace-shared `clientDir` and the
  // per-principal `tokenDir`. The DCR registration goes to one; tokens +
  // verifier + identity to the other; invalidateCredentials targets each
  // explicitly.

  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await chmod(dir, 0o700);
    } catch {
      // mkdir succeeded; chmod failure is non-fatal (file mode 0o600 still
      // protects the contents). A permissive parent leaks existence of
      // credentials via directory listings but not their values.
    }
  }

  private async readJson<T>(dir: string, name: string): Promise<T | null> {
    const path = join(dir, name);
    if (!existsSync(path)) return null;
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as T;
    } catch (err) {
      log.debug("mcp", `[oauth] failed to read ${path}: ${String(err)}`);
      return null;
    }
  }

  private async writeJson(dir: string, name: string, value: unknown): Promise<void> {
    await this.ensureDir(dir);
    const path = join(dir, name);
    const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
    const content = JSON.stringify(value, null, 2);
    await writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  private async unlinkIfExists(dir: string, name: string): Promise<void> {
    const path = join(dir, name);
    if (!existsSync(path)) return;
    try {
      await unlink(path);
    } catch {
      // ignore — file may have been removed concurrently
    }
  }
}
