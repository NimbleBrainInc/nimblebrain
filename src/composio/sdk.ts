/**
 * Composio SDK adapter — the platform's single seam against
 * `@composio/core`. Owns every outbound call to Composio's hosted
 * backend so the rest of the codebase doesn't need to import the
 * SDK directly.
 *
 * Responsibilities:
 *
 *   1. Build an authenticated `Composio` client from `COMPOSIO_API_KEY`
 *      and an optional `COMPOSIO_API_BASE_URL` override (used by tests
 *      and self-hosted shims).
 *   2. Wrap every SDK call in a 10s timeout so a hanging Composio API
 *      can't block install / connect / disconnect requests indefinitely.
 *   3. Compute the platform-side `user_id` value passed to Composio for
 *      every action — the formula is exported so the routes and the
 *      install path stay in lockstep (drift would route tool calls to
 *      a different Composio namespace and silently 404).
 *   4. Eagerly validate operator config at server start so deploy-time
 *      misconfiguration surfaces with a precise error rather than a
 *      generic 500 on the first user click.
 *
 * Architectural notes:
 *
 *   - **Single platform-wide API key.** One `COMPOSIO_API_KEY` per
 *     pod. Per-workspace isolation lives in the Composio `user_id`
 *     value (see `composioUserId`).
 *   - **Multi-tenant safety.** When the bouncer is configured (a
 *     reliable signal of multi-tenant deployment), `NB_TENANT_ID`
 *     is required so the Composio `user_id` is globally unique.
 *     Without the tenant prefix, two tenants with the same `wsId`
 *     would collide in Composio's namespace.
 *   - **`auth: composio` only.** This module is dormant when no
 *     Composio-backed connector is installed. `validateComposioConfig`
 *     short-circuits when `COMPOSIO_API_KEY` is unset.
 */

import { AuthScheme, Composio } from "@composio/core";
import type { ConnectorOwner } from "../identity/connector-owner.ts";
import { getBouncerMode } from "../oauth/bouncer-config.ts";
import { publicOrigin } from "../oauth/public-origin.ts";
import { log } from "../observability/log.ts";

/** Default Composio API host. Overridable via `COMPOSIO_API_BASE_URL`. */
export const COMPOSIO_API_BASE = "https://backend.composio.dev";

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

// ── Config validation ────────────────────────────────────────────────

/**
 * Inspect the process env for Composio configuration. Called eagerly
 * by `composioAuthRoutes(ctx)` at server startup so misconfiguration
 * fails fast with a precise message.
 *
 * Throws on:
 *   - `COMPOSIO_API_BASE_URL` set but not parseable / not http(s)
 *     (open-redirect surface on `/v1/composio-auth/proxy`)
 *   - Bouncer mode active but `NB_TENANT_ID` unset (multi-tenant
 *     deployment would silently collapse all tenants' Composio
 *     connections into one namespace)
 *
 * Returns:
 *   - `{ configured: false }` when `COMPOSIO_API_KEY` is unset.
 *     Composio integration is dormant — no startup warnings, no
 *     route surface activity until an operator sets the key.
 *   - `{ configured: true, baseUrl }` when ready to serve.
 *
 * Side-effects: emits one `[composio]` log line on first call so
 * operators see the integration status in pod logs without grepping
 * for it.
 */
export interface ComposioConfig {
  configured: boolean;
  baseUrl: string;
}

let _cachedConfig: ComposioConfig | undefined;

export function validateComposioConfig(): ComposioConfig {
  if (_cachedConfig) return _cachedConfig;

  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    log.info("[composio] integration: not configured (set COMPOSIO_API_KEY to enable)");
    _cachedConfig = { configured: false, baseUrl: COMPOSIO_API_BASE };
    return _cachedConfig;
  }

  const rawBaseUrl = process.env.COMPOSIO_API_BASE_URL?.trim();
  let baseUrl = COMPOSIO_API_BASE;
  if (rawBaseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawBaseUrl);
    } catch {
      throw new Error(`[composio] COMPOSIO_API_BASE_URL is not a valid URL: "${rawBaseUrl}"`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `[composio] COMPOSIO_API_BASE_URL must be http(s): "${rawBaseUrl}". ` +
          "Other schemes would expose `/v1/composio-auth/proxy` as an open redirect.",
      );
    }
    baseUrl = rawBaseUrl;
  }

  // Multi-tenant safety: the Composio `user_id` formula uses
  // `NB_TENANT_ID:wsId` when the tenant id is set. In multi-tenant
  // deploys (signalled by an active bouncer config) we MUST have the
  // tenant prefix or two tenants with the same wsId would share a
  // Composio namespace. Fail loud at startup so the misconfig is
  // caught at deploy time, not at first user click.
  const bouncer = getBouncerMode();
  const tid = process.env.NB_TENANT_ID?.trim();
  if (bouncer && !tid) {
    throw new Error(
      "[composio] NB_TENANT_ID is required when running in bouncer (multi-tenant) mode. " +
        "Without a tenant prefix, Composio `user_id` collisions could leak connected " +
        "accounts across tenants. Set NB_TENANT_ID via the deployment env to a stable " +
        "per-pod tenant identifier.",
    );
  }

  log.info(`[composio] integration: configured (base=${baseUrl}${tid ? `, tid=${tid}` : ""})`);
  _cachedConfig = { configured: true, baseUrl };
  return _cachedConfig;
}

/**
 * Test-only. Reset cached config between tests.
 *
 * Production code reads env once at process start and never re-reads —
 * operators must restart the platform after changing
 * `COMPOSIO_API_KEY`, `COMPOSIO_API_BASE_URL`, or `NB_TENANT_ID`.
 * Mirrors the bouncer-config caching contract.
 */
export function _resetComposioConfigForTest(): void {
  _cachedConfig = undefined;
}

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

/**
 * Build an authenticated Composio SDK client. The `baseURL` override
 * is plumbed through `COMPOSIO_API_BASE_URL` (validated at startup).
 *
 * Internal — every public function in this module instantiates its
 * own client per call. The SDK is cheap to construct; sharing a
 * long-lived client across requests would couple cancellation /
 * abort semantics to its lifetime, which we don't need.
 */
function composioClient(apiKey: string): Composio {
  // `validateComposioConfig` runs full validation on its first call
  // (eagerly, at server startup, via `composioAuthRoutes`). Every
  // subsequent call — including this one, on every SDK request —
  // returns the cached `ComposioConfig` without re-reading env or
  // re-validating. The "validate" in the name reflects the
  // first-call semantics; here it's a fast cache hit.
  const cfg = validateComposioConfig();
  return new Composio({ apiKey, baseURL: cfg.baseUrl });
}

/**
 * Initiate a Composio connection request. Returns the URL the
 * browser should navigate to and the `connectedAccountId` the
 * platform persists on callback. Errors surface verbatim — the
 * caller decides how to map them to API responses.
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
  const composio = composioClient(opts.apiKey);
  const connRequest = (await withTimeout("connectedAccounts.initiate", () =>
    composio.connectedAccounts.initiate(opts.userId, opts.authConfigId, {
      callbackUrl: opts.callbackUrl,
      allowMultiple: true,
    }),
  )) as unknown as {
    redirectUrl?: unknown;
    redirectUri?: unknown;
    id?: unknown;
    connectedAccountId?: unknown;
  };

  const redirectUrl = (connRequest.redirectUrl ?? connRequest.redirectUri) as unknown;
  const connectedAccountId = (connRequest.connectedAccountId ?? connRequest.id) as unknown;
  if (typeof redirectUrl !== "string" || redirectUrl.length === 0) {
    throw new Error("Composio initiate: missing redirect URL on connection request");
  }
  if (typeof connectedAccountId !== "string" || connectedAccountId.length === 0) {
    throw new Error("Composio initiate: missing connected_account_id on connection request");
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
 * `initiate` is the correct AND non-deprecated call here: the 2026-07-03 sunset
 * that pushes Composio-managed OAuth to `link()` explicitly excludes non-OAuth
 * schemes (API key / bearer / basic). For an API-key auth config Composio
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
  const composio = composioClient(opts.apiKey);
  // SDK types the `config` as a broad ConnectionData union; `AuthScheme.APIKey`
  // builds the API_KEY-shaped member ({ authScheme, val: { status, ...fields } }).
  const connRequest = (await withTimeout("connectedAccounts.initiate(apikey)", () =>
    composio.connectedAccounts.initiate(opts.userId, opts.authConfigId, {
      config: AuthScheme.APIKey(opts.fields),
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
  const composio = composioClient(opts.apiKey);
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
    const composio = composioClient(opts.apiKey);
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
 * Reads `COMPOSIO_API_KEY` from `process.env`. If unset, the
 * upstream-delete step is skipped (`upstreamDeleted: false`) — the
 * local file still gets removed so platform state is consistent
 * even when the SDK is unreachable. Operators following the
 * `uninstall → revoke at Composio dashboard` flow are explicitly
 * supported by this design.
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
    "../bundles/composio-connection.ts"
  );

  let upstreamDeleted = false;
  let localDeleted = false;
  let lastError: string | undefined;

  const apiKey = process.env.COMPOSIO_API_KEY?.trim();

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
  const composio = composioClient(opts.apiKey);
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
