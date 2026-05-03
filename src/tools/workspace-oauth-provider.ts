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

export interface WorkspaceOAuthProviderOptions {
  wsId: string;
  serverName: string;
  workDir: string;
  /** Absolute callback URL — must match the /v1/mcp-auth/callback route. */
  callbackUrl: string;
  /**
   * Optional principal id when the bundle is `oauthScope: "member"`. When
   * present, `tokens.json`, `verifier.json`, and `identity.json` resolve
   * under `…/members/<memberId>/`. `client.json` (DCR registration) stays
   * at the workspace level — one DCR'd client represents "NimbleBrain on
   * behalf of `<wsId>`" and is shared across members; rotating it would
   * force every member to re-consent.
   *
   * Must satisfy the same `safeKey` shape we use for credential keys
   * (alphanumerics + `._-`, no path separators) so a member id can never
   * traverse out of the credentials tree. Validated at construction.
   *
   * Omit (or `undefined`) for `oauthScope: "workspace"` — the legacy path
   * where tokens live at the workspace level.
   */
  memberId?: string;
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
function parseIdTokenClaims(
  idToken: string,
): { sub?: string; email?: string; name?: string } | null {
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
    payloadJson = atob(padded + padding);
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
const MEMBER_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
function assertSafeMemberId(memberId: string): void {
  if (
    typeof memberId !== "string" ||
    memberId.length === 0 ||
    memberId.length > 128 ||
    !MEMBER_ID_RE.test(memberId) ||
    memberId === "." ||
    memberId === ".."
  ) {
    throw new Error(
      `[workspace-oauth-provider] invalid memberId: "${memberId}". ` +
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
  private readonly wsId: string;
  private readonly serverName: string;
  private readonly memberId?: string;
  /**
   * Workspace-shared directory for the DCR registration. `client.json`
   * lives here regardless of scope — same NimbleBrain-as-a-client identity
   * for every member of the workspace.
   */
  private readonly clientDir: string;
  /**
   * Per-principal directory for tokens / verifier / identity. Equals
   * `clientDir` for `oauthScope: "workspace"`; `${clientDir}/members/<memberId>/`
   * for `oauthScope: "member"`. Member files never leak across principals.
   */
  private readonly tokenDir: string;
  private readonly callbackUrl: string;
  /** Canonical form of `callbackUrl` for self-match comparison. */
  private readonly canonicalCallback: string;
  private readonly allowInsecureRemotes: boolean;
  private readonly onInteractiveAuthRequired?: (authorizationUrl: string) => void;
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
    this.wsId = opts.wsId;
    this.serverName = opts.serverName;
    this.memberId = opts.memberId;
    this.callbackUrl = opts.callbackUrl;
    this.canonicalCallback = canonicalEndpoint(new URL(opts.callbackUrl));
    this.allowInsecureRemotes = opts.allowInsecureRemotes === true;
    this.onInteractiveAuthRequired = opts.onInteractiveAuthRequired;
    this.clientDir = join(
      opts.workDir,
      "workspaces",
      opts.wsId,
      "credentials",
      "mcp-oauth",
      opts.serverName,
    );
    if (opts.memberId !== undefined) {
      assertSafeMemberId(opts.memberId);
      this.tokenDir = join(this.clientDir, "members", opts.memberId);
    } else {
      this.tokenDir = this.clientDir;
    }
  }

  // ── OAuthClientProvider interface ─────────────────────────────────

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `NimbleBrain (${this.wsId})`,
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
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
   * The principal id this provider represents — `memberId` for member-scope
   * bundles, `undefined` for workspace-shared bundles. Read by the
   * disconnect route + connections snapshot to key per-principal records.
   */
  getMemberId(): string | undefined {
    return this.memberId;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.cachedClientInfo) return this.cachedClientInfo;
    // DCR client info is workspace-shared regardless of scope — every
    // member of the workspace authenticates as the same NimbleBrain
    // OAuth client.
    const data = await this.readJson<OAuthClientInformationFull>(this.clientDir, "client.json");
    if (data) this.cachedClientInfo = data;
    return data ?? undefined;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.cachedClientInfo = info;
    await this.writeJson(this.clientDir, "client.json", info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.cachedTokens) return this.cachedTokens;
    const data = await this.readJson<OAuthTokens>(this.tokenDir, "tokens.json");
    if (data) this.cachedTokens = data;
    return data ?? undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.cachedTokens = tokens;
    await this.writeJson(this.tokenDir, "tokens.json", tokens);
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
          await this.writeJson(this.tokenDir, "identity.json", claims);
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
      this.tokenDir,
      "identity.json",
    );
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.writeJson(this.tokenDir, "verifier.json", { codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const data = await this.readJson<{ codeVerifier: string }>(this.tokenDir, "verifier.json");
    if (!data) throw new Error("PKCE code verifier missing — OAuth flow corrupted");
    return data.codeVerifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.pendingFlow) {
      throw new Error(
        "[workspace-oauth-provider] redirectToAuthorization called without an active flow",
      );
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

        const res = await fetch(current.toString(), { redirect: "manual" });
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

    const registryPromise = registerInteractiveFlow(stateParam, this.wsId, this.serverName);
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
      await this.unlinkIfExists(this.clientDir, "client.json");
    }
    if (scope === "all" || scope === "tokens") {
      this.cachedTokens = null;
      await this.unlinkIfExists(this.tokenDir, "tokens.json");
      // identity.json is bound 1:1 with tokens — when tokens go, the
      // captured identity is no longer meaningful (the user might
      // re-auth as someone else next time).
      await this.unlinkIfExists(this.tokenDir, "identity.json");
    }
    if (scope === "all" || scope === "verifier") {
      await this.unlinkIfExists(this.tokenDir, "verifier.json");
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
  async revokeAndDeleteTokens(opts: {
    bundleUrl: string;
    fetchImpl?: typeof fetch;
  }): Promise<{
    revoked: { access?: boolean; refresh?: boolean };
    deletedLocal: boolean;
    error?: string;
  }> {
    const fetcher = opts.fetchImpl ?? fetch;
    const tokens = await this.tokens();
    const clientInfo = await this.clientInformation();
    const result: { revoked: { access?: boolean; refresh?: boolean }; deletedLocal: boolean; error?: string } = {
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

    // Discover the revocation endpoint from OAuth metadata. Best-effort —
    // skip revocation entirely if discovery fails (server may not advertise
    // a revocation_endpoint, in which case there's nothing to call).
    let revocationEndpoint: string | undefined;
    try {
      const bundleOrigin = new URL(opts.bundleUrl).origin;
      const metadataUrl = `${bundleOrigin}/.well-known/oauth-authorization-server`;
      // SSRF defense: validate the discovery target with the same
      // allowlist as bundle URLs, modulo the allowInsecureRemotes
      // flag set at construction. A misconfigured catalog entry could
      // otherwise let revocation discovery touch a private network.
      validateBundleUrl(new URL(metadataUrl), { allowInsecure: this.allowInsecureRemotes });
      const res = await fetcher(metadataUrl);
      if (res.ok) {
        const meta = (await res.json()) as { revocation_endpoint?: unknown };
        if (typeof meta.revocation_endpoint === "string") {
          revocationEndpoint = meta.revocation_endpoint;
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
    await this.invalidateCredentials("tokens");
    await this.invalidateCredentials("verifier");
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
