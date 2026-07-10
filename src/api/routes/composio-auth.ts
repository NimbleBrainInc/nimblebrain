import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import {
  type ComposioConnection,
  saveComposioConnection,
} from "../../bundles/composio-connection.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../../bundles/connection.ts";
import { slugifyServerName } from "../../bundles/paths.ts";
import { consumeConnectFlow, registerConnectFlow } from "../../composio/connect-flow-registry.ts";
import {
  COMPOSIO_CALLBACK_PATH,
  composioCallbackUrl,
  composioUserId,
  findActiveComposioConnection,
  initiateComposioConnection,
  validateComposioConfig,
} from "../../composio/sdk.ts";
import { type ConnectorOwner, connectorOwnerKey } from "../../identity/connector-owner.ts";
import { IdentityConnectorStore } from "../../identity/connector-store.ts";
import { log } from "../../observability/log.ts";
import type { ConnectorCatalogEntry } from "../../registries/projection.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";
import { profileConnectorsUrl, workspaceConnectorsUrl } from "./connectors-redirect.ts";

/**
 * OAuth integration routes for connectors backed by Composio as a
 * remote OAuth aggregator. Composio holds the vendor's tokens and
 * exposes the toolkit's tools through its own MCP endpoint; the
 * platform only persists an opaque `connectedAccountId` per workspace
 * per connector.
 *
 * Three endpoints:
 *
 * - `POST /v1/composio-auth/initiate` (workspace-authed): asks
 *   Composio to begin a connection for this workspace, sets a session-
 *   bound `nb_composio_state` cookie, and returns the redirect URL the
 *   browser should navigate to. **POST-only** + `X-Workspace-Id` header
 *   forces a CORS preflight, killing simple-form CSRF — same posture
 *   as `/v1/mcp-auth/initiate`.
 *
 * - `GET /v1/composio-auth/callback` (unauthenticated): the return
 *   leg from Composio after the user consents at the vendor. Recovers
 *   the (owner, connectorId) from the server-side flow record that an
 *   authenticated `/initiate` created under the URL nonce — never from
 *   the query — so an unauthenticated caller can't land a connection
 *   under another owner. A session cookie binds the nonce to the
 *   calling browser on top. Then writes `connection.json`.
 *
 * - `GET /v1/composio-auth/proxy` (unauthenticated): white-label
 *   forwarder. Registered with the vendor as our OAuth client's
 *   redirect URI; 302s to Composio's real callback so the address bar
 *   shows our domain throughout the consent dance. Stateless — never
 *   sees tokens; only forwards browser navigation.
 */

/**
 * Inline CSS for the post-callback success page, sha256-pinned in the
 * CSP just like `/v1/mcp-auth/callback`. The page is visible for one
 * second before the meta-refresh fires; brevity is the point.
 */
const SUCCESS_PAGE_STYLE = `html,body{margin:0;height:100%}
body{font-family:'Satoshi',system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f7;color:#171717;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:1rem;box-sizing:border-box;-webkit-font-smoothing:antialiased}
.h{font-family:'Erode',Georgia,serif;font-size:clamp(2.5rem,6.5vw,4.25rem);font-weight:500;letter-spacing:-0.02em;margin:0;animation:rise .35s ease-out both}
.wm{margin-top:1.5rem;font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:#737373;font-weight:700;display:flex;align-items:center;gap:.55rem;animation:rise .35s ease-out .08s both}
.wm svg{width:.65rem;height:.65rem;display:block}
.fb{position:fixed;bottom:1.25rem;font-size:.75rem;color:#525252;margin:0;font-weight:500}
.fb a{color:#404040;text-decoration:none;border-bottom:1px dotted #a3a3a3}
.fb a:hover{color:#d4620a;border-bottom-color:#d4620a}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-color-scheme:dark){body{background:#0a0a09;color:#e5e5e5}.wm{color:#a3a3a3}.fb{color:#a3a3a3}.fb a{color:#d4d4d4;border-bottom-color:#525252}.fb a:hover{color:#f59542;border-bottom-color:#f59542}}
@media (prefers-reduced-motion:reduce){.h,.wm{animation:none}}`;
const SUCCESS_PAGE_STYLE_SHA256 = createHash("sha256").update(SUCCESS_PAGE_STYLE).digest("base64");
const SUCCESS_PAGE_CSP = `default-src 'none'; style-src 'sha256-${SUCCESS_PAGE_STYLE_SHA256}'; frame-ancestors 'none'; base-uri 'none'`;

/**
 * CSP for HTML error responses (auth-failed, session-mismatch). The
 * default platform CSP doesn't apply automatically to error branches,
 * and these pages render escaped attacker-influenced data inside a
 * `<pre>` block — `escapeHtml` covers script injection, but the
 * stricter posture matches the success page and is free
 * defense-in-depth. No inline `<style>` here, so the policy can be
 * tighter than the success page's (no style-src hash needed).
 */
const ERROR_PAGE_CSP = `default-src 'none'; frame-ancestors 'none'; base-uri 'none'`;

/**
 * Slug allowed in the `cid` query param. Matches our catalog id form
 * (`<reverse-dns>/<name>`, e.g. `com.google/gmail`). Filesystem
 * traversal is already defeated downstream by `connectorSlug`'s
 * slash→dash replacement — this is defense-in-depth at the route
 * boundary.
 *
 * Explicit `..` and `//` substring rejection on top of the char-class
 * regex: no legitimate catalog id contains either, so rejecting them
 * here surfaces malformed input earlier than the slug step.
 */
const CID_RE = /^[A-Za-z0-9._/-]{1,128}$/;
function isValidConnectorId(cid: string): boolean {
  return CID_RE.test(cid) && !cid.includes("..") && !cid.includes("//");
}

/** Where the browser returns after a successful connect — the owner's connectors surface. */
function connectorsReturnUrl(owner: ConnectorOwner): string {
  return owner.type === "workspace" ? workspaceConnectorsUrl(owner.wsId) : profileConnectorsUrl();
}

export function composioAuthRoutes(ctx: AppContext) {
  // Eager startup validation — same pattern as `getBouncerMode()` in
  // `mcpAuthRoutes`. Misconfigured `COMPOSIO_API_BASE_URL` or missing
  // `NB_TENANT_ID` in multi-tenant mode throws here, at server start,
  // not on the first user click.
  validateComposioConfig();

  const app = new Hono<AppEnv>();

  // ── POST /v1/composio-auth/initiate ───────────────────────────────
  app.post(
    "/v1/composio-auth/initiate",
    requireAuth(ctx.authOptions),
    requireWorkspace(ctx.workspaceStore),
    async (c) => {
      const parsed = await parseInitiateRequest(c);
      if (parsed instanceof Response) return parsed;
      const { connectorId } = parsed;
      const wsId = c.var.workspaceId;

      const entry = await loadInitiateCatalogEntry(ctx, connectorId);
      if (entry instanceof Response) return entry;

      const creds = resolveComposioCredentials(entry, connectorId, wsId);
      if (creds instanceof Response) return creds;
      const { apiKey, authConfigId } = creds;

      return connectComposio(ctx, c, {
        entry,
        connectorId,
        owner: { type: "workspace", wsId },
        apiKey,
        authConfigId,
      });
    },
  );

  // ── POST /v1/composio-auth/initiate-identity ──────────────────────
  // The identity-plane sibling of `/initiate`: connect a PERSONAL Composio
  // connector on the caller's own identity (the "Connect" click from the
  // profile). No workspace — the connection binds `{type:"user"}`, its
  // `connection.json` lives under the user's credential root, and the callback
  // lands the user on `/profile/connectors`.
  app.post("/v1/composio-auth/initiate-identity", requireAuth(ctx.authOptions), async (c) => {
    const parsed = await parseInitiateRequest(c);
    if (parsed instanceof Response) return parsed;
    const { connectorId } = parsed;

    const userId = ctx.runtime.resolveRequestUserId(c.var.identity);

    // A personal connector must be installed on the caller's identity before it
    // can be connected — mirrors the OAuth identity initiate
    // (`/v1/mcp-auth/initiate-identity`). Without this the callback would persist
    // a `connection.json` under the user root with no install record to read it —
    // a dangling (own-credential-only) state. Not-installed is a 404 client error.
    const serverName = slugifyServerName(connectorId);
    const installed = await new IdentityConnectorStore({ workDir: ctx.runtime.getWorkDir() }).get(
      userId,
      serverName,
    );
    if (!installed) {
      return apiError(404, "connector_not_found", `"${serverName}" is not one of your connectors.`);
    }

    const entry = await loadInitiateCatalogEntry(ctx, connectorId);
    if (entry instanceof Response) return entry;

    // `resolveComposioCredentials` uses its second arg only for log context —
    // there is no workspace here; pass the user id.
    const creds = resolveComposioCredentials(entry, connectorId, userId);
    if (creds instanceof Response) return creds;
    const { apiKey, authConfigId } = creds;

    return connectComposio(ctx, c, {
      entry,
      connectorId,
      owner: { type: "user", userId },
      apiKey,
      authConfigId,
    });
  });

  // ── GET /v1/composio-auth/callback ────────────────────────────────
  app.get("/v1/composio-auth/callback", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");

    const validated = await validateCallbackParams(c);
    if (validated instanceof Response) return validated;
    const { connectedAccountId, status, cid, owner } = validated;

    const entry = await loadCallbackCatalogEntry(ctx, c, cid);
    if (entry instanceof Response) return entry;

    const composioUser = composioUserId(owner);
    const connection: ComposioConnection = {
      connectedAccountId,
      toolkit: entry.composio.toolkit,
      userId: composioUser,
      connectedAt: new Date().toISOString(),
      status,
    };

    try {
      await saveComposioConnection(ctx.runtime.getWorkDir(), owner, cid, connection);
    } catch (err) {
      log.error(
        `[composio-auth] failed to persist connection for ${cid} (${connectorOwnerKey(owner)}): ${errMessage(err)}`,
      );
      return c.text("internal_error", 500);
    }

    await recoverCallbackSource(ctx, cid, owner);

    // One-shot cookie — clear on success so a refresh of this page
    // can't be used as a replay vector.
    c.header("Set-Cookie", buildComposioStateCookie("", 0, ctx.secureCookies));

    const returnUrl = connectorsReturnUrl(owner);
    const safeReturnUrl = escapeHtml(returnUrl);
    c.header("Content-Security-Policy", SUCCESS_PAGE_CSP);
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connection complete</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="1;url=${safeReturnUrl}">
<style>${SUCCESS_PAGE_STYLE}</style></head>
<body>
<h1 class="h">You're in.</h1>
<div class="wm"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0L12 6L6 12L0 6Z" fill="#d4620a"/></svg>NimbleBrain</div>
<p class="fb">not redirecting? <a href="${safeReturnUrl}">go back &rarr;</a></p>
</body></html>`,
    );
  });

  // ── GET /v1/composio-auth/proxy ───────────────────────────────────
  //
  // White-label forwarder. The vendor's OAuth client redirect URI is
  // registered as this endpoint; we 302 to Composio's real callback
  // so the browser address bar never shows `backend.composio.dev`
  // during the consent dance. Stateless — passes query params
  // verbatim, holds no secrets, sees no tokens. Browser-side only:
  // the response body is empty, only the Location header matters.
  app.get("/v1/composio-auth/proxy", (c) => {
    c.header("Cache-Control", "no-store");
    // Read from the validated cached config rather than re-reading
    // `process.env.COMPOSIO_API_BASE_URL` each request. The cache
    // value has already passed the http(s) protocol check at
    // startup; reading process.env directly would bypass that
    // guard if env mutated post-startup (unlikely in production
    // but cheap defense-in-depth).
    const apiBase = validateComposioConfig().baseUrl;
    const url = new URL(c.req.url);
    const target = `${apiBase.replace(/\/+$/, "")}${COMPOSIO_CALLBACK_PATH}${url.search}`;
    return c.redirect(target, 302);
  });

  return app;
}

// ── /initiate + /callback concern helpers ─────────────────────────
//
// Each returns either its success value or a ready-to-send `Response`;
// the handler forwards the `Response` (`instanceof Response`) and
// otherwise proceeds. The validation order and every status code /
// error string are the same as an inline implementation — these only
// move code, not behavior.

/** A catalog entry confirmed to be Composio-backed (`composio` config present). */
type ComposioCatalogEntry = ConnectorCatalogEntry & {
  composio: NonNullable<ConnectorCatalogEntry["composio"]>;
};

/** Message text for an unknown thrown value — `.message` for Errors, else stringified. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse the initiate body and validate `connectorId` is a catalog id, else an error Response. */
async function parseInitiateRequest(
  c: Context<AppEnv>,
): Promise<{ connectorId: string } | Response> {
  let body: { connectorId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const connectorId = typeof body.connectorId === "string" ? body.connectorId : "";
  if (!connectorId || !isValidConnectorId(connectorId)) {
    return apiError(400, "bad_request", "connectorId is required and must be a catalog id.");
  }
  return { connectorId };
}

/** Load `connectorId` from the catalog and confirm it is Composio-backed, else an error Response. */
async function loadInitiateCatalogEntry(
  ctx: AppContext,
  connectorId: string,
): Promise<ComposioCatalogEntry | Response> {
  const directory = ctx.runtime.getConnectorDirectory();
  const entry = await directory.catalogById(connectorId);
  if (!entry) {
    return apiError(404, "connector_not_found", `Connector "${connectorId}" not in catalog.`);
  }
  if (entry.auth !== "composio" || !entry.composio) {
    return apiError(
      400,
      "wrong_auth_kind",
      `Connector "${connectorId}" is not Composio-backed (auth=${entry.auth}).`,
    );
  }
  return entry as ComposioCatalogEntry;
}

/** Resolve the platform Composio API key and the connector's auth-config id from env, else an error Response. */
function resolveComposioCredentials(
  entry: ComposioCatalogEntry,
  connectorId: string,
  logCtx: string,
): { apiKey: string; authConfigId: string } | Response {
  // Platform-wide Composio API key. Single source for the whole
  // deployment; per-owner isolation lives in `user_id` (the Composio-side
  // identity, derived from the workspace or the user). A missing key is an
  // operator config error — surface a generic 500 and log specifics rather
  // than telling the API caller which env var to set (the API isn't
  // operator-facing). `logCtx` is the owner label, for log context only.
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    log.warn(
      "[composio-auth] COMPOSIO_API_KEY not set; cannot initiate connection " +
        `for ${connectorId} (${logCtx})`,
    );
    return apiError(500, "composio_unconfigured", "Composio integration not configured.");
  }

  // Per-connector Composio `auth_config_id`. Lives in the catalog
  // entry's `_meta.composio.authConfigEnv` as the name of the env
  // var holding the value; the actual id (e.g. `ac_xxx`) is
  // operator-supplied via 1Password → ExternalSecret → pod env.
  // The indirection keeps the catalog file free of deployment-
  // specific identifiers.
  const authConfigEnvName = entry.composio.authConfigEnv;
  const authConfigId = process.env[authConfigEnvName]?.trim();
  if (!authConfigId) {
    log.warn(
      `[composio-auth] ${authConfigEnvName} not set; cannot initiate ${connectorId} (${logCtx})`,
    );
    return apiError(
      500,
      "composio_unconfigured",
      `Composio auth config for "${connectorId}" not configured.`,
    );
  }

  return { apiKey, authConfigId };
}

/** Reuse an already-ACTIVE Composio account for this owner (adopting it), or null to run a fresh OAuth initiate. */
async function adoptExistingComposioConnection(
  ctx: AppContext,
  c: Context<AppEnv>,
  args: {
    entry: ComposioCatalogEntry;
    connectorId: string;
    owner: ConnectorOwner;
    apiKey: string;
    authConfigId: string;
  },
): Promise<Response | null> {
  const { entry, connectorId, owner, apiKey, authConfigId } = args;
  const composioUser = composioUserId(owner);
  const ownerLabel = connectorOwnerKey(owner);
  // The chat-side `manageConnections` flow and an earlier explicit
  // click both create connected accounts here; without this dedup
  // we'd hit Composio's "Multiple connected accounts found … use
  // allowMultiple" error or pile up duplicates. We adopt the existing
  // account by writing our own connection.json against its id,
  // transitioning the bundle state to `running`, and telling the SPA
  // to navigate to the success page — no second OAuth round-trip.
  try {
    const existing = await findActiveComposioConnection({
      apiKey,
      userId: composioUser,
      authConfigId,
    });
    if (existing) {
      // Ordering matters: bring the source online BEFORE writing
      // connection.json. `disconnect()` calls
      // `teardownConnectionSource` which removes the source from
      // the workspace registry — a reconnect must restart it.
      // Install-path eager-start works for first connect because
      // the source has never been torn down; this path handles
      // every subsequent connect.
      //
      // The reordering matters when ensureSourceRegistered fails.
      // Writing connection.json eagerly would leave the user with
      // a "connected" state on disk (state derivation reads
      // connection.json on next boot) while the source isn't
      // running, plus a success page that contradicts the
      // connector's actual state. By starting the source first,
      // a failure leaves a clean slate: connection.json is absent,
      // the user sees an honest error here, and a retry runs the
      // same adopt-existing path with no half-written state to
      // reconcile.
      const serverName = slugifyServerName(connectorId);
      const lifecycle = ctx.runtime.getLifecycle();
      try {
        if (owner.type === "workspace") {
          await lifecycle.ensureSourceRegistered(serverName, owner.wsId, ctx.runtime.getWorkDir());
        } else {
          // Identity plane: the source holder starts + registers the personal
          // connector into the user's registry from its persisted record.
          await lifecycle.getIdentityConnectorSource(
            owner.userId,
            serverName,
            ctx.runtime.getWorkDir(),
          );
        }
      } catch (err) {
        log.warn(
          `[composio-auth] adopt: source registration failed for ${connectorId} (${ownerLabel}): ${errMessage(err)}`,
        );
        return apiError(
          502,
          "composio_adopt_source_start_failed",
          "Reconnect failed: the existing Composio account was found but the MCP source could not start. Try Disconnect, then Connect again.",
        );
      }
      const connection: ComposioConnection = {
        connectedAccountId: existing.id,
        toolkit: entry.composio.toolkit,
        userId: composioUser,
        connectedAt: new Date().toISOString(),
        status: existing.status,
      };
      await saveComposioConnection(ctx.runtime.getWorkDir(), owner, connectorId, connection);
      if (owner.type === "workspace") {
        lifecycle.recordConnectionStateChange(
          serverName,
          owner.wsId,
          WORKSPACE_PRINCIPAL_ID,
          "running",
        );
      }
      return c.json({
        authorizationUrl: connectorsReturnUrl(owner),
        alreadyConnected: true,
      });
    }
  } catch (err) {
    // Lookup failures shouldn't block a fresh OAuth attempt —
    // fall through to initiate. Log so the operator can investigate.
    log.warn(
      `[composio-auth] connected-account lookup failed for ${connectorId} (${ownerLabel}): ${errMessage(err)}`,
    );
  }
  return null;
}

/**
 * Connect a Composio-backed connector for `owner`: adopt an existing ACTIVE
 * connected account if one exists (no second OAuth round-trip), else begin a
 * fresh connection. Shared by the workspace and identity initiate routes.
 */
async function connectComposio(
  ctx: AppContext,
  c: Context<AppEnv>,
  args: {
    entry: ComposioCatalogEntry;
    connectorId: string;
    owner: ConnectorOwner;
    apiKey: string;
    authConfigId: string;
  },
): Promise<Response> {
  const adopted = await adoptExistingComposioConnection(ctx, c, args);
  if (adopted) return adopted;
  return initiateFreshComposioConnection(ctx, c, {
    connectorId: args.connectorId,
    owner: args.owner,
    apiKey: args.apiKey,
    authConfigId: args.authConfigId,
  });
}

/** Begin a fresh Composio OAuth connection: bind the state cookie and return the vendor authorization URL. */
async function initiateFreshComposioConnection(
  ctx: AppContext,
  c: Context<AppEnv>,
  args: {
    connectorId: string;
    owner: ConnectorOwner;
    apiKey: string;
    authConfigId: string;
  },
): Promise<Response> {
  const { connectorId, owner, apiKey, authConfigId } = args;
  const composioUser = composioUserId(owner);
  const ownerLabel = connectorOwnerKey(owner);
  const nonce = randomBytes(32).toString("hex");

  // The callback (which has no auth middleware — the user returns from Composio
  // without our headers) recovers the owner and connector from the server-side
  // flow record keyed by this nonce, never from the query string, so the return
  // leg can't be steered to a different owner. The callback URL therefore
  // carries only the nonce; Composio appends `connected_account_id`/`status`.
  const callbackUrl = new URL(composioCallbackUrl());
  callbackUrl.searchParams.set("n", nonce);

  let initiateResponse: { redirectUrl: string; connectedAccountId: string };
  try {
    initiateResponse = await initiateComposioConnection({
      apiKey,
      userId: composioUser,
      authConfigId,
      callbackUrl: callbackUrl.toString(),
    });
  } catch (err) {
    log.warn(
      `[composio-auth] initiate failed for ${connectorId} (${ownerLabel}): ${errMessage(err)}`,
    );
    return apiError(502, "composio_initiate_failed", "Composio rejected the connection initiate.");
  }

  // Register the flow only once Composio has accepted the initiate, so a failed
  // initiate leaves no orphan record. The nonce is a value only this
  // authenticated initiate could mint — that's what makes the record the
  // callback's anti-forgery gate.
  registerConnectFlow(nonce, owner, connectorId);

  // Cookie binds the nonce to this browser session. Scoped to
  // /v1/composio-auth/callback so it's only sent back on the return leg — never
  // leaked to /initiate calls on adjacent paths or to the SPA. The server-side
  // flow record is the anti-forgery gate; this cookie adds session binding on
  // top, so a nonce leaked from the URL (referrer, history) can't be completed
  // from a different browser.
  const stateHash = sha256Hex(nonce);
  c.header("Set-Cookie", buildComposioStateCookie(stateHash, 900, ctx.secureCookies));

  return c.json({
    authorizationUrl: initiateResponse.redirectUrl,
  });
}

/** Validate the callback query params and the session-binding cookie, returning the verified tuple or an error Response. */
async function validateCallbackParams(c: Context<AppEnv>): Promise<
  | {
      connectedAccountId: string;
      status: string;
      cid: string;
      owner: ConnectorOwner;
    }
  | Response
> {
  const connectedAccountId =
    c.req.query("connectedAccountId") ?? c.req.query("connected_account_id");
  const status = c.req.query("status") ?? "ACTIVE";
  const error = c.req.query("error");
  const nonce = c.req.query("n");

  if (error) {
    c.header("Content-Security-Policy", ERROR_PAGE_CSP);
    return c.html(
      `<html><body><h3>Connection failed</h3><pre>${escapeHtml(error)}</pre></body></html>`,
      400,
    );
  }
  if (!nonce) {
    return c.text("missing nonce", 400);
  }
  if (!connectedAccountId) {
    return c.text("missing connectedAccountId", 400);
  }

  // Session binding: the cookie set by /initiate must hash to the nonce, so a
  // nonce leaked from the URL can't be completed from a different browser.
  const cookieValue = readCookie(c.req.header("cookie"), "nb_composio_state");
  if (!cookieValue || !timingSafeEqualHex(cookieValue, sha256Hex(nonce))) {
    c.header("Content-Security-Policy", ERROR_PAGE_CSP);
    return c.html(
      "<html><body><h3>Authorization session mismatch.</h3>" +
        "<p>Re-initiate the connection from NimbleBrain.</p></body></html>",
      400,
    );
  }

  // Anti-forgery gate: recover (owner, connectorId) from the server-side record
  // an authenticated /initiate created under this nonce. No record ⟹ the nonce
  // was never issued (or is already used / expired) — reject rather than trust
  // the query. This is what stops an unauthenticated caller from landing a
  // connection under another owner. One-shot: `consume` removes the record.
  const flow = consumeConnectFlow(nonce);
  if (!flow) {
    c.header("Content-Security-Policy", ERROR_PAGE_CSP);
    return c.html(
      "<html><body><h3>Unknown or expired authorization flow.</h3>" +
        "<p>Re-initiate the connection from NimbleBrain.</p></body></html>",
      400,
    );
  }

  return { connectedAccountId, status, cid: flow.connectorId, owner: flow.owner };
}

/** Load a callback `cid` from the catalog and confirm it is Composio-backed, else an error Response. */
async function loadCallbackCatalogEntry(
  ctx: AppContext,
  c: Context<AppEnv>,
  cid: string,
): Promise<ComposioCatalogEntry | Response> {
  const directory = ctx.runtime.getConnectorDirectory();
  const entry = await directory.catalogById(cid);
  if (!entry || entry.auth !== "composio" || !entry.composio) {
    return c.text(`connector "${cid}" is not Composio-backed`, 400);
  }
  return entry as ComposioCatalogEntry;
}

/** Bring the connector's MCP source online after a callback (non-fatal), for either owner. */
async function recoverCallbackSource(
  ctx: AppContext,
  cid: string,
  owner: ConnectorOwner,
): Promise<void> {
  // Transition the lifecycle state from `not_authenticated` (set
  // at boot when connection.json was absent) to `running`. Without
  // this the UI would keep showing "Sign-in required" until the
  // next platform restart, even though tools were already callable.
  //
  // After a Disconnect → Connect cycle, `teardownConnectionSource`
  // has already removed the source from the registry — pure state
  // mutation isn't enough to recover. `ensureSourceRegistered` brings
  // the source back up from the persisted BundleRef if it's missing,
  // no-ops if it's already there (first-connect path, where the
  // install-eager-start already registered).
  const serverName = slugifyServerName(cid);
  try {
    const lifecycle = ctx.runtime.getLifecycle();
    if (owner.type === "workspace") {
      await lifecycle.ensureSourceRegistered(serverName, owner.wsId, ctx.runtime.getWorkDir());
      lifecycle.recordConnectionStateChange(
        serverName,
        owner.wsId,
        WORKSPACE_PRINCIPAL_ID,
        "running",
      );
    } else {
      // Identity plane: the source holder starts + registers into the user's
      // registry (the same lazy-start dispatch uses). There is no per-principal
      // connection-state machine here — running-ness is derived from whether
      // the source is registered.
      await lifecycle.getIdentityConnectorSource(
        owner.userId,
        serverName,
        ctx.runtime.getWorkDir(),
      );
    }
  } catch (err) {
    // Non-fatal — the next boot will derive `running` from
    // connection.json and start the source from the persisted ref.
    // Log and continue to the success page.
    log.warn(
      `[composio-auth] source recovery failed for ${cid} (${connectorOwnerKey(owner)}) (will recover on restart): ${errMessage(err)}`,
    );
  }
}

/** Build the `nb_composio_state` Set-Cookie value scoped to the callback path. */
function buildComposioStateCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `nb_composio_state=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/v1/composio-auth/callback",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// ── Helpers shared with mcp-auth.ts in shape (kept inline to avoid
// cross-route coupling — these are stock building blocks). ─────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
function timingSafeEqualHex(a: string, b: string): boolean {
  if (!SHA256_HEX_RE.test(a) || !SHA256_HEX_RE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq);
    const v = trimmed.slice(eq + 1);
    if (k === name) return v;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}
