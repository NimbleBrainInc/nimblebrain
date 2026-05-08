import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { validateBundleUrl } from "../bundles/url-validator.ts";
import { log } from "../cli/log.ts";
import { register as registerInteractiveFlow } from "./oauth-flow-registry.ts";

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
export type OAuthOwnerContext =
  | { type: "workspace"; wsId: string }
  | { type: "user"; userId: string };

export interface WorkspaceOAuthProviderOptions {
  /**
   * The principal whose tokens these are — either a workspace (shared)
   * or a single user (personal). Drives both the credential storage
   * path and the principal id used in connection state tracking.
   */
  owner: OAuthOwnerContext;
  serverName: string;
  workDir: string;
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
}

/**
 * Reserved authorize-URL params that the OAuth flow controls itself.
 * Operator-supplied `additionalAuthorizationParams` from
 * `workspace.json` MUST NOT include these — overriding any of them
 * would let a misconfigured catalog entry break PKCE binding or steal
 * the redirect target. Validated at config load (see
 * `validateAdditionalAuthorizationParams`).
 */
export const RESERVED_AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  // OIDC-style hijack vectors: `request` / `request_uri` smuggle a
  // signed/unsigned JWT request object that can override every other
  // parameter; `response_mode` can change response delivery (form_post,
  // fragment) in ways that break our callback assumptions.
  "request",
  "request_uri",
  "response_mode",
] as const;

/**
 * Throw if any reserved key appears in the params map. Called at the
 * boundary where `workspace.json` is parsed — bundle install /
 * `seedInstance` — so a bad config fails loud rather than at OAuth-
 * flow time.
 */
export function validateAdditionalAuthorizationParams(
  params: Record<string, string> | undefined,
): void {
  if (!params) return;
  const reserved = RESERVED_AUTHORIZE_PARAMS.filter((k) => k in params);
  if (reserved.length > 0) {
    throw new Error(
      `[workspace-oauth-provider] additionalAuthorizationParams cannot include reserved keys: ${reserved.join(", ")}`,
    );
  }
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
  private readonly staticClient?: WorkspaceOAuthProviderOptions["staticClient"];
  private readonly scopes?: string[];
  private readonly additionalAuthorizationParams?: Record<string, string>;
  private readonly abortSignal?: AbortSignal;
  /** Cached DCR result + tokens to avoid redundant disk reads within a flow. */
  private cachedClientInfo: OAuthClientInformationFull | null = null;
  private cachedTokens: OAuthTokens | null = null;
  /**
   * The promise for the in-flight authorization. Set by `state()` to a
   * provider-local deferred (used by headless flows that resolve in
   * `redirectToAuthorization`). On the interactive branch, it's REPLACED
   * with the `oauth-flow-registry` promise — that one resolves when the
   * HTTP callback route receives the code from the user's browser.
   *
   * `awaitPendingFlow()` reads `.promise` so it works for both branches
   * uniformly.
   */
  private pendingFlow: { promise: Promise<string>; deferred?: Deferred<string> } | null = null;
  /**
   * The latest state value generated by `state()`. Captured so the
   * interactive branch of `redirectToAuthorization` can register the
   * correct flow with `oauth-flow-registry` even if the SDK adds extra
   * state munging between `state()` and the URL build.
   */
  private currentState: string | null = null;

  constructor(opts: WorkspaceOAuthProviderOptions) {
    this.owner = opts.owner;
    this.serverName = opts.serverName;
    this.callbackUrl = opts.callbackUrl;
    this.canonicalCallback = canonicalEndpoint(new URL(opts.callbackUrl));
    this.allowInsecureRemotes = opts.allowInsecureRemotes === true;
    this.onInteractiveAuthRequired = opts.onInteractiveAuthRequired;
    this.staticClient = opts.staticClient;
    this.scopes = opts.scopes;
    // Validate at construction so a bad config fails fast — same boundary
    // discipline as `assertSafeOwnerId`.
    validateAdditionalAuthorizationParams(opts.additionalAuthorizationParams);
    this.additionalAuthorizationParams = opts.additionalAuthorizationParams;
    this.abortSignal = opts.abortSignal;

    // Resolve the per-owner storage root. Both scopes use the same
    // `<root>/<scope-dir>/<id>/credentials/mcp-oauth/<server>/` layout
    // so consumers can swap owner contexts without learning a new
    // directory shape.
    const ownerSegment = opts.owner.type === "workspace" ? "workspaces" : "users";
    const ownerId = opts.owner.type === "workspace" ? opts.owner.wsId : opts.owner.userId;
    assertSafeOwnerId(ownerId);
    this.dataDir = join(
      opts.workDir,
      ownerSegment,
      ownerId,
      "credentials",
      "mcp-oauth",
      opts.serverName,
    );
  }

  // ── OAuthClientProvider interface ─────────────────────────────────

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const ownerLabel =
      this.owner.type === "workspace" ? this.owner.wsId : `user:${this.owner.userId}`;
    const meta: OAuthClientMetadata = {
      client_name: `NimbleBrain (${ownerLabel})`,
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
    if (this.cachedClientInfo) {
      if (this.isClientInfoUsable(this.cachedClientInfo)) return this.cachedClientInfo;
      // Cached entry has stale redirect_uri (e.g. NB_API_URL changed
      // between registration and now). Drop it so we re-register fresh
      // below, then on disk so future reads agree.
      this.cachedClientInfo = null;
      await this.unlinkIfExists(this.dataDir, "client.json");
    }
    // DCR client info is workspace-shared regardless of scope — every
    // member of the workspace authenticates as the same NimbleBrain
    // OAuth client.
    const data = await this.readJson<OAuthClientInformationFull>(this.dataDir, "client.json");
    if (!data) return undefined;
    if (!this.isClientInfoUsable(data)) {
      // Drift detection: the platform's redirect_uri (derived from
      // NB_API_URL) doesn't match what was registered with the
      // authorization server when this client was DCR'd. Returning the
      // stale entry here means the next /authorize sends a redirect_uri
      // the AS doesn't recognize, surfacing as `invalid_redirect_uri`
      // long after the user has clicked Connect. Drop the entry and
      // let the SDK trigger a fresh DCR call with the current URI.
      log.warn(
        `[oauth] ${this.serverName} cached DCR client redirect_uri drift detected (registered=${
          data.redirect_uris?.[0] ?? "<none>"
        }, current=${this.callbackUrl}) — discarding cached client.json so the next flow re-registers`,
      );
      await this.unlinkIfExists(this.dataDir, "client.json");
      return undefined;
    }
    this.cachedClientInfo = data;
    return data;
  }

  /**
   * Drift check for a DCR `client.json`. Returns true when the
   * registered `redirect_uris` includes the current callbackUrl —
   * i.e. the AS will accept what we send at /authorize and /token.
   * Returns false when the registration is stale (the canonical
   * NB_API_URL-changed-between-deploys case), so callers know to
   * re-register rather than serve a doomed flow.
   *
   * Conservative: a missing or non-array `redirect_uris` is treated
   * as drift (force re-register). That handles broken on-disk state
   * the same as known drift.
   */
  private isClientInfoUsable(info: OAuthClientInformationFull): boolean {
    const uris = info.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) return false;
    return uris.includes(this.callbackUrl);
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
    this.cachedClientInfo = info;
    await this.writeJson(this.dataDir, "client.json", info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.cachedTokens) return this.cachedTokens;
    const data = await this.readJson<OAuthTokens>(this.dataDir, "tokens.json");
    if (data) this.cachedTokens = data;
    return data ?? undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.cachedTokens = tokens;
    await this.writeJson(this.dataDir, "tokens.json", tokens);
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
    await this.writeJson(this.dataDir, "verifier.json", { codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const data = await this.readJson<{ codeVerifier: string }>(this.dataDir, "verifier.json");
    if (!data) throw new Error("PKCE code verifier missing — OAuth flow corrupted");
    return data.codeVerifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.pendingFlow) {
      throw new Error(
        "[workspace-oauth-provider] redirectToAuthorization called without an active flow",
      );
    }
    // Track A: append operator-supplied additional authorize params
    // (e.g. Google's access_type=offline + prompt=consent for refresh-
    // token issuance). Reserved keys are blocked at construction so we
    // can't accidentally overwrite client_id / state / PKCE here.
    if (this.additionalAuthorizationParams) {
      for (const [k, v] of Object.entries(this.additionalAuthorizationParams)) {
        url.searchParams.set(k, v);
      }
    }
    // Local deferred for the headless branch. The interactive branch
    // doesn't use this — it swaps `pendingFlow.promise` for the flow
    // registry's promise instead.
    const d = this.pendingFlow.deferred;

    // Follow the authorize redirect chain hop-by-hop. Headless providers
    // (Reboot `Anonymous`, client_credentials-style flows) eventually 302 to
    // our own callback with the authorization code already in the URL, at
    // which point we can extract it directly. Reboot specifically does two
    // hops: /__/oauth/authorize → /__/oauth/callback → our callback.
    //
    // We use manual redirect handling (not fetch's default follow) so we
    // can inspect every Location, stop as soon as one targets our callback,
    // and avoid actually dispatching a request to our own server (which
    // would tangle our own HTTP event loop into the probe).
    //
    // Real interactive providers (Granola, Claude.ai hosted) redirect to a
    // login page on a different origin — the loop never lands on our
    // callback and we fall through to the interactive branch.
    const MAX_HOPS = 10;
    let current = url;
    try {
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        // SSRF defense: validate EVERY hop (including the initial URL the
        // server handed us), not just the configured bundle URL. The
        // authorize URL and every Location header are attacker-controlled —
        // a compromised remote MCP server could otherwise use our fetch()
        // as an internal-network probe tool (AWS IMDS, RFC1918 admin
        // panels, loopback services). Wrap with our marker prefix so the
        // outer catch rethrows instead of silently falling through to the
        // interactive branch.
        try {
          validateBundleUrl(current, { allowInsecure: this.allowInsecureRemotes });
        } catch (err) {
          throw new Error(
            `[workspace-oauth-provider] SSRF block on ${current.toString()}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // Honor lifecycle's timeout: when the controller aborts, the
        // in-flight TCP read terminates with an AbortError instead of
        // running its full network timeout in the background.
        const res = await fetch(current.toString(), {
          redirect: "manual",
          ...(this.abortSignal ? { signal: this.abortSignal } : {}),
        });
        if (res.status < 300 || res.status >= 400) {
          // Non-redirect response — provider sent us a login page (200) or
          // an error (4xx/5xx). Not headless.
          break;
        }
        const location = res.headers.get("location");
        if (!location) break;
        const next = new URL(location, current);
        if (canonicalEndpoint(next) === this.canonicalCallback) {
          const code = next.searchParams.get("code");
          const errParam = next.searchParams.get("error");
          if (code) {
            log.debug(
              "mcp",
              `[oauth] headless flow: ${this.serverName} got code=${code.slice(0, 8)}… after ${hop + 1} hop(s)`,
            );
            d?.resolve(code);
            return;
          }
          if (errParam) {
            const err = new Error(
              `[workspace-oauth-provider] authorization server returned error: ${errParam}`,
            );
            d?.reject(err);
            throw err;
          }
          break;
        }
        current = next;
      }
    } catch (probeErr) {
      // Rethrow our own explicit errors (authz server error, SSRF block)
      // so callers see the real cause instead of the generic
      // interactive-branch surface. Swallow network failures and fall
      // through to the interactive branch below.
      if (probeErr instanceof Error && probeErr.message.includes("[workspace-oauth-provider]")) {
        d?.reject(probeErr);
        throw probeErr;
      }
      log.debug("mcp", `[oauth] ${this.serverName} redirect probe failed: ${String(probeErr)}`);
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

    // Flow registry just needs an opaque owner key for diagnostics; either
    // wsId or userId is fine (and they live in different keyspaces — no
    // collision risk). Workspace owner uses the wsId; user owner uses
    // a `user:` prefix so an operator reading registry state can tell
    // them apart at a glance.
    const ownerKey =
      this.owner.type === "workspace" ? this.owner.wsId : `user:${this.owner.userId}`;
    const registryPromise = registerInteractiveFlow(stateParam, ownerKey, this.serverName);
    this.pendingFlow = { promise: registryPromise };

    // Notify the lifecycle / UI so the bundle transitions to pending_auth
    // and the banner appears. Errors from the callback must not break the
    // OAuth dance — log and continue. The registry registration above is
    // already in place, so the callback handler can resolve the flow even
    // if the lifecycle notification path is broken.
    if (this.onInteractiveAuthRequired) {
      try {
        this.onInteractiveAuthRequired(url.toString());
      } catch (cbErr) {
        log.warn(
          `[oauth] onInteractiveAuthRequired callback threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
        );
      }
    }

    // Throw the SDK's own UnauthorizedError so `Client.connect()` aborts
    // cleanly — `McpSource.start()` catches this and awaits
    // `awaitPendingFlow()`, which now returns the registry promise.
    throw new UnauthorizedError(
      `Interactive OAuth required for ${this.serverName} — pending user authorization at ${url.origin}.`,
    );
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "client") {
      this.cachedClientInfo = null;
      await this.unlinkIfExists(this.dataDir, "client.json");
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

    // Discover the revocation endpoint. Best-effort — skip revocation
    // entirely if discovery fails (server may not advertise a
    // revocation_endpoint, in which case there's nothing to call).
    //
    // Discovery order:
    //   1. RFC 9728 Protected Resource Metadata at
    //      `<bundleOrigin>/.well-known/oauth-protected-resource`. This
    //      lists `authorization_servers[]` whose origins host the AS
    //      metadata. Required for vendors where the AS lives at a
    //      different origin than the resource (Google: AS at
    //      `oauth2.googleapis.com`, bundle at `gmailmcp.googleapis.com`;
    //      Microsoft: AS at `login.microsoftonline.com`).
    //   2. RFC 8414 fallback at
    //      `<bundleOrigin>/.well-known/oauth-authorization-server` for
    //      vendors that co-locate the AS with the resource (Granola,
    //      Notion, HubSpot).
    let revocationEndpoint: string | undefined;
    try {
      const bundleOrigin = new URL(opts.bundleUrl).origin;
      const asOrigins = await discoverAuthorizationServerOrigins(
        fetcher,
        bundleOrigin,
        this.allowInsecureRemotes,
      );
      // Try each AS in order. First one that advertises a
      // revocation_endpoint wins.
      for (const asOrigin of asOrigins) {
        const metadataUrl = `${asOrigin}/.well-known/oauth-authorization-server`;
        try {
          validateBundleUrl(new URL(metadataUrl), {
            allowInsecure: this.allowInsecureRemotes,
          });
          const res = await fetcher(metadataUrl);
          if (!res.ok) continue;
          const meta = (await res.json()) as { revocation_endpoint?: unknown };
          if (typeof meta.revocation_endpoint === "string") {
            revocationEndpoint = meta.revocation_endpoint;
            break;
          }
        } catch (innerErr) {
          log.debug(
            "mcp",
            `[oauth] ${this.serverName} AS metadata fetch failed at ${metadataUrl}: ${
              innerErr instanceof Error ? innerErr.message : String(innerErr)
            }`,
          );
        }
      }
    } catch (err) {
      log.debug(
        "mcp",
        `[oauth] ${this.serverName} revocation discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (revocationEndpoint && clientInfo) {
      try {
        // Revoke both tokens in sequence. RFC 7009 doesn't define an
        // order; we revoke the refresh token first because it's the
        // longer-lived credential — even if access-token revocation
        // races a separate caller's request, the AS won't issue a fresh
        // one once the RT is gone.
        if (tokens.refresh_token) {
          result.revoked.refresh = await postRevoke(
            fetcher,
            revocationEndpoint,
            tokens.refresh_token,
            "refresh_token",
            clientInfo,
          );
        }
        if (tokens.access_token) {
          result.revoked.access = await postRevoke(
            fetcher,
            revocationEndpoint,
            tokens.access_token,
            "access_token",
            clientInfo,
          );
        }
      } catch (err) {
        // Don't fail disconnect on revocation errors — log + continue
        // to local cleanup.
        result.error = err instanceof Error ? err.message : String(err);
        log.warn(
          `[oauth] ${this.serverName} revocation failed: ${result.error} (continuing with local cleanup)`,
        );
      }
    }

    // Always clear local state regardless of upstream revocation result.
    // `all` is broader than the literal "tokens" the method name implies,
    // and intentional: leaving the cached DCR `client.json` behind across
    // a disconnect/reconnect is the well-trodden bug path. If `NB_API_URL`
    // changes between a disconnect and the next reconnect, the AS still
    // has the old `redirect_uri` registered to the cached `client_id`,
    // and the next /authorize comes back as `Invalid redirect_uri`.
    // Re-registering on reconnect costs one DCR roundtrip — cheap insurance
    // against a confusing prod failure mode.
    await this.invalidateCredentials("all");
    result.deletedLocal = true;
    return result;
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
