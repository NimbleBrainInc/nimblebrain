/**
 * Composio SDK adapter — the platform's single seam against
 * `@composio/core`. Owns every outbound call to Composio's hosted
 * backend so the rest of the codebase doesn't need to import the
 * SDK directly.
 *
 * Responsibilities:
 *
 *   1. Build an authenticated `Composio` client from the resolved
 *      provider config (`./config.ts`) — the declared
 *      `connectors.providers.composio` block, or the `COMPOSIO_*` env
 *      fallback.
 *   2. Wrap every SDK call in a 10s timeout so a hanging Composio API
 *      can't block install / connect / disconnect requests indefinitely.
 *   3. Compute the platform-side `user_id` value passed to Composio for
 *      every action — the formula is exported so the routes and the
 *      install path stay in lockstep (drift would route tool calls to
 *      a different Composio namespace and silently 404).
 *
 * Architectural notes:
 *
 *   - **Single platform-wide API key.** One broker credential per
 *     pod. Per-workspace isolation lives in the Composio `user_id`
 *     value (see `composioUserId`).
 *   - **`auth: composio` only.** This module is dormant when no
 *     Composio-backed connector is installed; an unconfigured deploy
 *     registers no provider, so nothing here ever runs and the vendor
 *     SDK is never loaded.
 */

import type { ConnectorOwner } from "../../../identity/connector-owner.ts";
import { publicOrigin } from "../../../oauth/public-origin.ts";
import { validateComposioConfig } from "./config.ts";

/**
 * Path Composio's hosted callback lives at — the destination of the
 * white-label `/v1/composio-auth/proxy` redirect. Kept as a constant
 * so the proxy route and any future tooling share one source of truth.
 */
export const COMPOSIO_CALLBACK_PATH = "/api/v3.1/toolkits/auth/callback";

/** Max time a single Composio SDK call may run before we abort. */
const COMPOSIO_TIMEOUT_MS = 10_000;

/**
 * Verification budget for an API-key connect. `waitForConnection` polls the
 * freshly-created connected account until it reaches ACTIVE (or throws on a
 * terminal FAILED/EXPIRED). Non-redirect schemes normally resolve on the
 * first poll, so a few seconds is ample. Kept below `COMPOSIO_TIMEOUT_MS` (the
 * outer per-call backstop) so the SDK's own typed timeout/failure error
 * surfaces first instead of our generic abort.
 */
const COMPOSIO_APIKEY_VERIFY_MS = 8_000;

// ── User-ID formula ─────────────────────────────────────────────────

/**
 * Compute the `user_id` value passed to Composio at every API call.
 *
 * Multi-tenant production runs one tenant per pod with `NB_TENANT_ID`
 * stamped at deploy time; workspace IDs aren't globally unique
 * (`ws_01abc` exists in every tenant) so the tenant prefix is the
 * thing that disambiguates Composio's namespace. Single-tenant / local
 * dev simply uses `wsId` — Composio doesn't care about format, only
 * that the string be stable per connection.
 *
 * Drift between the value used at `initiate` time and the value
 * embedded in the runtime MCP URL would route tool calls to a
 * different Composio namespace and 404 silently. One formula, one
 * caller — that's why this lives in the SDK adapter, not the route
 * file.
 */
export function composioUserId(owner: ConnectorOwner): string {
  const tid = process.env.NB_TENANT_ID?.trim();
  // A personal (identity) connector namespaces its Composio-side identity with a
  // `user:` segment so it can never collide with a workspace's (`ws_...` vs
  // `user:usr_...`). A workspace owner is byte-identical to the prior `wsId` form.
  const key = owner.type === "workspace" ? owner.wsId : `user:${owner.userId}`;
  return tid ? `${tid}:${key}` : key;
}

// ── URL helpers ─────────────────────────────────────────────────────

/** Outward-facing callback URL the platform passes to Composio. */
export function composioCallbackUrl(): string {
  return `${publicOrigin()}/v1/composio-auth/callback`;
}

// ── SDK call wrappers ───────────────────────────────────────────────

/**
 * Run an SDK call with a hard 10s timeout. Composio's API is normally
 * fast (<1s); anything past 10s is almost certainly a network hang or
 * a regional outage. Surfacing a clear timeout beats blocking the
 * user's install click for 30+ seconds while the SDK retries.
 */
async function withTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`[composio] ${label} timed out after ${COMPOSIO_TIMEOUT_MS / 1000}s`)),
          COMPOSIO_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Vendor SDK (lazy) ───────────────────────────────────────────────

/**
 * The slice of `@composio/core` this adapter uses, declared locally rather than
 * imported. The vendor is reached ONLY through the lazy dynamic import below —
 * no top-level `@composio/core` import (static OR type-only) exists, so nothing
 * links the vendor at module load. Each SDK call site narrows the `unknown`
 * results to the concrete shape it needs (as the existing casts already do).
 */
interface ComposioClient {
  connectedAccounts: {
    list(query: unknown): Promise<unknown>;
    link(userId: string, authConfigId: string, opts: unknown): Promise<unknown>;
    initiate(userId: string, authConfigId: string, opts: unknown): Promise<unknown>;
    delete(connectedAccountId: string): Promise<unknown>;
  };
  create(userId: string, config: unknown): Promise<unknown>;
}

interface ComposioCoreModule {
  Composio: new (opts: {
    apiKey: string;
    baseURL: string;
    disableVersionCheck: boolean;
    allowTracking: boolean;
  }) => ComposioClient;
  AuthScheme: { APIKey(fields: Record<string, string>): unknown };
}

let _vendorLoadCount = 0;

/**
 * The one place `@composio/core` is imported — lazily, via a dynamic import
 * reached only on a brokered call.
 *
 * `@composio/core` ships a single large bundled `index.mjs`; under bun,
 * statically linking its named exports is order-sensitive and intermittently
 * fails with "Export named 'AuthScheme' not found" — a static binding resolves
 * against the real module before a test's `mock.module("@composio/core")` can
 * apply, so it aborts at import time. Loading lazily sidesteps that entirely: a
 * Composio-less deploy never links the vendor, and a test's mock is always
 * registered before a call resolves this import. The module system dedups the
 * real import, so this stays cheap on the hot path without a hand-rolled cache
 * (a cached promise would also pin one test file's mock across every sibling).
 */
async function loadComposioCore(): Promise<ComposioCoreModule> {
  _vendorLoadCount += 1;
  // The runtime dynamic import (a call expression, not a top-level `from`
  // import) is the only reference to the vendor. Narrow it to the local slice.
  return (await import("@composio/core")) as unknown as ComposioCoreModule;
}

/**
 * Test-only. Reset the vendor load counter so a test can assert a code path
 * never triggered a vendor load. Mirrors `_resetComposioConfigForTest`.
 */
export function _resetComposioVendorForTest(): void {
  _vendorLoadCount = 0;
}

/** Test-only. How many times the vendor SDK has been (lazily) loaded since the last reset. */
export function _composioVendorLoadCountForTest(): number {
  return _vendorLoadCount;
}

/**
 * Build an authenticated Composio SDK client. The `baseURL` comes from the
 * resolved provider config (the declared block, validated at
 * startup).
 *
 * Internal + async — awaits the lazy vendor load, then constructs a fresh
 * client per call. The SDK is cheap to construct; sharing a long-lived client
 * across requests would couple cancellation / abort semantics to its lifetime,
 * which we don't need.
 */
async function composioClient(apiKey: string): Promise<ComposioClient> {
  const composioCore = await loadComposioCore();
  // `validateComposioConfig` runs full validation on its first call
  // (eagerly, at server startup, via `composioAuthRoutes`). Every
  // subsequent call — including this one, on every SDK request —
  // returns the cached `ComposioConfig` without re-resolving. The
  // "validate" in the name reflects the first-call semantics; here
  // it's a fast cache hit.
  const cfg = validateComposioConfig();
  // Opt out of the SDK's two per-request "phone home" behaviors. This client
  // is constructed per request (see above), so both fire on every call:
  //   - disableVersionCheck: the npm version check fetches `registry.npmjs.org`
  //     and logs an "upgrade available" line each time. The version is pinned in
  //     package.json, so the nag has no signal — just log noise and wasted egress.
  //   - allowTracking: anonymous usage telemetry to `telemetry.composio.dev`.
  //     Tenant runtimes should not emit per-request analytics.
  return new composioCore.Composio({
    apiKey,
    baseURL: cfg.baseUrl,
    disableVersionCheck: true,
    allowTracking: false,
  });
}

/**
 * Begin a redirect-based Composio connection. Returns the URL the browser
 * should navigate to and the `connectedAccountId` the platform persists on
 * callback. Errors surface verbatim — the caller decides how to map them to
 * API responses.
 *
 * `link()` — Composio's hosted authentication — is the call for every
 * redirectable scheme, and the reason is two-fold:
 *
 *   1. `initiate()` is retired for Composio-managed OAuth auth configs (the
 *      vendor answers 400 once enforced). `link()` works for managed and
 *      custom configs alike and returns the same shape.
 *   2. Composio's hosted page collects the auth config's required
 *      connection-initiation fields — a Jira subdomain, a Zoho region, a
 *      WhatsApp WABA id — directly from the connecting user, and it needs no
 *      help from us: the SDK's `link()` exposes no channel for supplying
 *      them. (The underlying endpoint does carry a `connection_data`
 *      pre-fill, but it is absent from `CreateConnectedAccountLinkOptions`
 *      and the options schema strips unknown keys, so it is unreachable
 *      through this method.) A toolkit that declares a required field is
 *      unconnectable any other way, since `initiate()` — the only call that
 *      accepts them — is the one being retired.
 *
 * The trade-off is the address bar: the consent dance now visibly runs on
 * Composio's domain rather than behind the white-label `/proxy` forwarder.
 * The hosted page is co-branded, and an unconnectable toolkit is the
 * alternative.
 *
 * `allowMultiple: true` is belt-and-suspenders — we only reach here
 * after `findActiveComposioConnection` returned null, but a race
 * (chat-side flow firing concurrently, an INACTIVE account from a
 * prior revoke, etc.) could create one between the list and this
 * call. Allowing the duplicate is strictly better than blowing up
 * the user's click.
 */
export async function initiateComposioConnection(opts: {
  apiKey: string;
  userId: string;
  authConfigId: string;
  callbackUrl: string;
}): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const composio = await composioClient(opts.apiKey);
  let raw: unknown;
  try {
    raw = await withTimeout("connectedAccounts.link", () =>
      composio.connectedAccounts.link(opts.userId, opts.authConfigId, {
        callbackUrl: opts.callbackUrl,
        allowMultiple: true,
      }),
    );
  } catch (err) {
    // `link()` reports every failure as one constant message and hangs the
    // vendor's response body off `.cause`; `initiate()` rethrew the vendor
    // error directly. Callers log `err.message`, so without this fold a 400
    // naming the auth config's missing field reads only as "Failed to create
    // connected account link" — the detail that made that class of bug
    // findable at all. Fold it back in and keep the original on `cause`.
    const cause = err instanceof Error ? err.cause : undefined;
    if (err instanceof Error && cause instanceof Error && cause.message) {
      throw new Error(`${err.message}: ${cause.message}`, { cause: err });
    }
    throw err;
  }
  const connRequest = raw as {
    redirectUrl?: unknown;
    redirectUri?: unknown;
    id?: unknown;
    connectedAccountId?: unknown;
  };

  const redirectUrl = (connRequest.redirectUrl ?? connRequest.redirectUri) as unknown;
  const connectedAccountId = (connRequest.connectedAccountId ?? connRequest.id) as unknown;
  if (typeof redirectUrl !== "string" || redirectUrl.length === 0) {
    throw new Error("Composio link: missing redirect URL on connection request");
  }
  if (typeof connectedAccountId !== "string" || connectedAccountId.length === 0) {
    throw new Error("Composio link: missing connected_account_id on connection request");
  }
  return { redirectUrl, connectedAccountId };
}

/**
 * Connect a Composio toolkit that authenticates by API key (or another
 * non-redirect scheme) for `userId`. Unlike {@link initiateComposioConnection}
 * there is no browser redirect: the user's key — plus any toolkit-specific
 * fields like PostHog's `subdomain` — is handed to Composio, which custodies
 * it. The platform persists only the opaque `connectedAccountId`, exactly the
 * trust posture of the OAuth path's `connection.json` (we never hold the key).
 *
 * `initiate` is the correct AND non-deprecated call here, and the one place it
 * survives: the retirement that moved Composio-managed OAuth to `link()` (see
 * {@link initiateComposioConnection}) explicitly excludes non-OAuth schemes
 * (API key / bearer / basic). For an API-key auth config Composio
 * returns a connected account with no `redirectUrl`; `waitForConnection` then
 * polls it to ACTIVE (or throws on a terminal FAILED/EXPIRED) — that poll is
 * our verification that the credential is usable. (Composio marks some API-key
 * accounts ACTIVE without a live upstream check, so a bad key may still only
 * surface on first tool call; `ConnectionRevalidator` catches that later.)
 *
 * On verification failure the half-created connected account is deleted
 * best-effort so a retry starts clean and the dangling record doesn't trip
 * Composio's `allowMultiple` guard. `fields` values live only for the duration
 * of this call — they're never returned, logged, or persisted.
 */
export async function connectComposioApiKey(opts: {
  apiKey: string;
  userId: string;
  authConfigId: string;
  fields: Record<string, string>;
}): Promise<{ connectedAccountId: string; status: string }> {
  const composio = await composioClient(opts.apiKey);
  const composioCore = await loadComposioCore();
  // SDK types the `config` as a broad ConnectionData union; `AuthScheme.APIKey`
  // builds the API_KEY-shaped member ({ authScheme, val: { status, ...fields } }).
  const connRequest = (await withTimeout("connectedAccounts.initiate(apikey)", () =>
    composio.connectedAccounts.initiate(opts.userId, opts.authConfigId, {
      config: composioCore.AuthScheme.APIKey(opts.fields),
      allowMultiple: true,
    }),
  )) as unknown as {
    id?: unknown;
    connectedAccountId?: unknown;
    waitForConnection: (timeoutMs?: number) => Promise<{ id?: unknown; status?: unknown }>;
  };

  // `initiate` populates `.id`, but mirror the OAuth sibling's
  // `id ?? connectedAccountId` fallback so the failure-cleanup delete below
  // can't be silently skipped (leaking a dangling account) if a future SDK
  // shape returns the id under `connectedAccountId` instead.
  const initiatedId =
    typeof connRequest.id === "string" && connRequest.id.length > 0
      ? connRequest.id
      : typeof connRequest.connectedAccountId === "string"
        ? connRequest.connectedAccountId
        : "";

  try {
    const account = await withTimeout("connectedAccounts.waitForConnection(apikey)", () =>
      connRequest.waitForConnection(COMPOSIO_APIKEY_VERIFY_MS),
    );
    const id = typeof account.id === "string" && account.id.length > 0 ? account.id : initiatedId;
    if (!id) {
      throw new Error("Composio API-key connect: missing connected_account_id");
    }
    // `waitForConnection` resolves only at ACTIVE (it throws on
    // FAILED/EXPIRED/timeout), but assert it explicitly so this helper's
    // postcondition — and the caller's subsequent "running" flip — can't drift
    // from the boot-state gate (which keys on status === "ACTIVE") if the SDK's
    // resolve contract ever changes. A non-ACTIVE resolve falls into the catch
    // below and deletes the half-created account.
    const status = typeof account.status === "string" ? account.status : "";
    if (status !== "ACTIVE") {
      throw new Error(
        `Composio API-key connect: account ${id} did not reach ACTIVE (status=${status || "unknown"})`,
      );
    }
    return { connectedAccountId: id, status };
  } catch (err) {
    // Verification failed (bad/insufficient key), timed out, or the account is
    // stuck non-ACTIVE — drop the dangling record so the next attempt is clean.
    if (initiatedId) {
      await deleteComposioConnectedAccount({
        apiKey: opts.apiKey,
        connectedAccountId: initiatedId,
      });
    }
    throw err;
  }
}

/**
 * Find an ACTIVE Composio connected account for `(userId,
 * authConfigId)`, if any. Returns the first match (Composio's
 * default ordering, which is created_at desc unless overridden).
 *
 * Used by the `/initiate` route to short-circuit the OAuth dance
 * when the user already has a working connection at Composio. The
 * chat-side `manageConnections` prompt and an earlier explicit
 * click both end up creating connected accounts here; without dedup
 * we'd either pile up duplicates or hit Composio's "Multiple
 * connected accounts found … use allowMultiple" error on the next
 * initiate.
 *
 * Returns null when no ACTIVE account exists. INITIATED / EXPIRED /
 * REVOKED accounts are *not* reused — those need a fresh OAuth flow.
 */
export async function findActiveComposioConnection(opts: {
  apiKey: string;
  userId: string;
  authConfigId: string;
}): Promise<{ id: string; status: string } | null> {
  const composio = await composioClient(opts.apiKey);
  const list = (await withTimeout("connectedAccounts.list", () =>
    composio.connectedAccounts.list({
      userIds: [opts.userId],
      authConfigIds: [opts.authConfigId],
      statuses: ["ACTIVE"],
      limit: 1,
    }),
  )) as unknown as { items?: Array<{ id?: unknown; status?: unknown }> };
  const first = list.items?.[0];
  if (!first) return null;
  if (typeof first.id !== "string" || first.id.length === 0) return null;
  const status = typeof first.status === "string" ? first.status : "ACTIVE";
  return { id: first.id, status };
}

/**
 * Delete a Composio connected account by id. Best-effort — Composio
 * may have already deleted it, the API may be transiently down, or
 * the id may already be invalid. Returns true on success, false on
 * any failure (caller logs). Never throws.
 *
 * Used by `lifecycle.disconnect` for Composio-backed bundles so a
 * subsequent Connect forces a fresh OAuth flow rather than adopting
 * the lingering "ACTIVE" account that disconnect-on-our-side
 * wouldn't otherwise touch.
 */
export async function deleteComposioConnectedAccount(opts: {
  apiKey: string;
  connectedAccountId: string;
}): Promise<boolean> {
  try {
    const composio = await composioClient(opts.apiKey);
    await withTimeout("connectedAccounts.delete", () =>
      composio.connectedAccounts.delete(opts.connectedAccountId),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Tear down everything a Composio-backed bundle owns: the upstream
 * Composio connected account (so vendor OAuth tokens are revoked)
 * AND the local `connection.json` (so the platform doesn't think
 * the bundle is still authenticated).
 *
 * Idempotent and best-effort throughout: every step swallows its own
 * errors and reports them in the return value. Safe to call from
 * both `disconnect` (keep the bundle installed, drop credentials)
 * and `uninstall` (full removal). Disconnect-only callers can read
 * the return value to surface revoke status; uninstall just calls
 * for side-effects.
 *
 * Reads the broker credential from the resolved provider config. If
 * Composio isn't configured, the upstream-delete step is skipped
 * (`upstreamDeleted: false`) — the local file still gets removed so
 * platform state is consistent even when the SDK is unreachable.
 * Operators following the `uninstall → revoke at Composio dashboard`
 * flow are explicitly supported by this design.
 *
 * Why both layers in one function: the alternative is two function
 * calls in every teardown path, each guarded by its own try/catch.
 * That recipe got mis-followed once already (uninstall had only the
 * `mcp-oauth` rmSync and missed composio entirely — see the QA
 * review that prompted this helper). One function, one canonical
 * cleanup recipe, two callers.
 */
export async function cleanupComposioBundle(opts: {
  workDir: string;
  wsId: string;
  connectorId: string;
}): Promise<{
  upstreamDeleted: boolean;
  localDeleted: boolean;
  lastError?: string;
}> {
  // Dynamic import to avoid a top-of-file dependency from the SDK
  // module on `src/bundles/composio-connection.ts`. The connection
  // module sits in the bundle layer; pulling it eagerly here would
  // create a cycle if a future refactor moves any of these helpers.
  // Cleanup is rare (uninstall / disconnect), so the import cost is
  // negligible vs. the architectural cleanliness.
  const { readComposioConnection, deleteComposioConnection } = await import(
    "../../../bundles/composio-connection.ts"
  );

  let upstreamDeleted = false;
  let localDeleted = false;
  let lastError: string | undefined;

  // `validateComposioConfig` throws on a misconfigured base URL / missing tenant
  // id, and this helper's contract (relied on by `lifecycle.disconnect`) is that
  // it never throws — a config error must not strand `connection.json` on disk.
  let apiKey = "";
  try {
    apiKey = validateComposioConfig().apiKey;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  let connectedAccountId: string | undefined;
  try {
    const connection = await readComposioConnection(
      opts.workDir,
      { type: "workspace", wsId: opts.wsId },
      opts.connectorId,
    );
    connectedAccountId = connection?.connectedAccountId;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  if (connectedAccountId && apiKey) {
    upstreamDeleted = await deleteComposioConnectedAccount({
      apiKey,
      connectedAccountId,
    });
  }

  try {
    localDeleted = await deleteComposioConnection(
      opts.workDir,
      { type: "workspace", wsId: opts.wsId },
      opts.connectorId,
    );
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  return {
    upstreamDeleted,
    localDeleted,
    ...(lastError ? { lastError } : {}),
  };
}

/**
 * Create a Composio session for `userId` with one toolkit's auth
 * config pre-attached. Returns the MCP server config (URL + headers)
 * the platform uses as the remote MCP target for this connector.
 *
 * Called once at install time; the resulting URL is persisted on the
 * BundleRef and reused on subsequent starts — Composio sessions are
 * reusable and the URL encodes the stable `sessionId`.
 *
 * `sessionPreset: "direct_tools"` exposes the toolkit's real tools
 * (e.g. `GMAIL_SEND_EMAIL`, `GMAIL_FETCH_EMAILS`) on the MCP
 * endpoint instead of Composio's default "tool router" meta-tool
 * set (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL`,
 * `COMPOSIO_MANAGE_CONNECTIONS`, etc.). For the platform model we
 * want — each catalog entry = one toolkit's tools surfaced directly
 * to the agent — this is the correct preset. It also disables
 * Composio's in-MCP `manageConnections` auth prompt by default,
 * which was driving the chat-side "click this link" modal that
 * bypassed our `/v1/composio-auth/initiate` flow.
 */
export async function createComposioSession(opts: {
  apiKey: string;
  userId: string;
  toolkit: string;
  authConfigId: string;
  /**
   * Optional allowlist of Composio tool slugs to expose. Defaults to
   * every tool the toolkit publishes — fine for small toolkits, but
   * for anything with dozens of tools (Outlook=282, Gmail=61) the
   * agent's tool-search dumps full descriptions of every match into
   * the LLM context. Pass a curated subset to keep the surface
   * agent-friendly.
   */
  tools?: string[];
}): Promise<{ type: "http" | "sse"; url: string; headers?: Record<string, string> }> {
  const composio = await composioClient(opts.apiKey);
  const config: Record<string, unknown> = {
    toolkits: [opts.toolkit],
    authConfigs: { [opts.toolkit]: opts.authConfigId },
    sessionPreset: "direct_tools",
  };
  if (opts.tools && opts.tools.length > 0) {
    // Per-toolkit allowlist. SDK accepts either a string[] or an
    // object with `enable`/`disable`/`tags` discriminators; the bare
    // array form is the simplest match for "these tools, full stop."
    config.tools = { [opts.toolkit]: opts.tools };
  }
  const session = (await withTimeout("create-session", () =>
    composio.create(opts.userId, config as unknown as Parameters<typeof composio.create>[1]),
  )) as unknown as {
    mcp?: { type?: unknown; url?: unknown; headers?: unknown };
  };
  const mcp = session.mcp;
  if (!mcp || typeof mcp.url !== "string" || mcp.url.length === 0) {
    throw new Error("Composio session: missing mcp.url");
  }
  return {
    type: mcp.type === "sse" ? "sse" : "http",
    url: mcp.url,
    ...(mcp.headers && typeof mcp.headers === "object"
      ? { headers: mcp.headers as Record<string, string> }
      : {}),
  };
}
