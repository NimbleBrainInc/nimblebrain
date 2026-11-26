import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { requireAuth } from "../../../api/middleware/auth.ts";
import { requireWorkspace, WORKSPACE_ROUTE_PREFIX } from "../../../api/middleware/workspace.ts";
import {
  connectorReturnUrl,
  type ReturnTarget,
  resolveReturnTarget,
} from "../../../api/routes/connectors-redirect.ts";
import { reinitiateParagraph } from "../../../api/routes/oauth-error-page.ts";
import type { ComposioInitiateResponse } from "../../../api/schemas/responses.ts";
import { type AppContext, type AppEnv, apiError, json } from "../../../api/types.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../../../connectors/runtime/connection.ts";
import { slugifyServerName } from "../../../connectors/runtime/paths.ts";
import { type ConnectorOwner, connectorOwnerKey } from "../../../identity/connector-owner.ts";
import { IdentityConnectorStore } from "../../../identity/connector-store.ts";
import {
  browserBindingMatches,
  buildFlowCookie,
  mintBrowserBinding,
} from "../../../oauth/flow-binding.ts";
import { log } from "../../../observability/log.ts";
import type { ConnectorCatalogEntry } from "../../catalog/types.ts";
import { composioAuthConfigId, validateComposioConfig } from "./config.ts";
import {
  consumeConnectFlow,
  peekConnectFlow,
  registerConnectFlow,
} from "./connect-flow-registry.ts";
import { type ComposioConnection, saveComposioConnection } from "./connection.ts";
import {
  COMPOSIO_CALLBACK_PATH,
  composioCallbackUrl,
  composioUserId,
  findActiveComposioConnection,
  getComposioAccountDisplayName,
  initiateComposioConnection,
} from "./sdk.ts";

/**
 * OAuth integration routes for connectors backed by Composio as a
 * remote OAuth aggregator. Composio holds the vendor's tokens and
 * exposes the toolkit's tools through its own MCP endpoint; the
 * platform only persists an opaque `connectedAccountId` per workspace
 * per connector.
 *
 * Three endpoints:
 *
 * - `POST /v1/workspaces/:wsId/composio-auth/initiate` (workspace-authed):
 *   asks Composio to begin a connection for a connector installed in this
 *   workspace, binds the caller's browser with a random `nb_composio_state`
 *   cookie, which only this host can set (`src/oauth/flow-binding.ts`), and returns the redirect URL the
 *   browser should navigate to. **POST-only**, and a cross-site write under
 *   `/v1/workspaces/` is refused — same posture as the workspace
 *   `mcp-auth/initiate`.
 *
 * - `GET /v1/composio-auth/callback` (unauthenticated): the return
 *   leg from Composio after the user consents at the vendor. Admits only
 *   the browser the initiate bound, consumes the flow, and writes
 *   `connection.json` from the server-side flow record: the owner, the
 *   connector and the connected account all come from what the initiate
 *   recorded, never from the query.
 *
 * - `GET /v1/composio-auth/proxy` (unauthenticated): white-label
 *   forwarder. Registered with the vendor as our OAuth client's
 *   redirect URI; 302s to Composio's real callback so the address bar
 *   shows our domain throughout the consent dance. Stateless — never
 *   sees tokens; only forwards browser navigation.
 */

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
 * `status` values on the callback that mean the connection did NOT establish.
 * Compared lower-cased, since the redirect param and Composio's own record
 * disagree on case for the same outcome (`failed` on the wire, `FAILED` on the
 * connected account).
 */
const FAILED_CALLBACK_STATUSES = new Set(["failed", "expired", "deleted", "inactive", "revoked"]);

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

/**
 * Where the browser returns after a successful connect: the owner's workspace's
 * Plugins page, or for a personal connector the workspace its connect was
 * started from (`returnTarget`, reopening its conversation if it names one),
 * else the profile.
 */
function connectorsReturnUrl(
  owner: ConnectorOwner,
  returnTarget: ReturnTarget | undefined,
  connected?: string,
): string {
  const isWorkspace = owner.type === "workspace";
  return connectorReturnUrl(
    isWorkspace ? owner.wsId : returnTarget?.wsId,
    connected ? { serverName: connected, owner: isWorkspace ? "workspace" : "person" } : undefined,
    isWorkspace ? undefined : returnTarget?.conversationId,
  );
}

export function composioAuthRoutes(ctx: AppContext) {
  // Eager startup validation — same pattern as `getBouncerMode()` in
  // `mcpAuthRoutes`. A misconfigured base URL or missing `NB_TENANT_ID`
  // in multi-tenant mode throws here, at server start, not on the first
  // user click.
  validateComposioConfig();

  const app = new Hono<AppEnv>();

  // ── POST /v1/workspaces/:wsId/composio-auth/initiate ──────────────
  app.post(
    `${WORKSPACE_ROUTE_PREFIX}/composio-auth/initiate`,
    requireAuth(ctx.authOptions),
    requireWorkspace(ctx),
    async (c) => {
      const parsed = await parseInitiateRequest(c);
      if (parsed instanceof Response) return parsed;
      const { connectorId } = parsed;
      const wsId = c.var.workspaceId;

      // Connecting writes the workspace's connection for this connector, so it
      // must be installed here first — mirrors the OAuth `/initiate`.
      if (!ctx.runtime.getLifecycle().getInstance(slugifyServerName(connectorId), wsId)) {
        return apiError(404, "connector_not_found", `Connector "${connectorId}" not installed.`);
      }

      const entry = await loadInitiateCatalogEntry(ctx, connectorId);
      if (entry instanceof Response) return entry;

      const creds = resolveComposioCredentials(entry, connectorId, wsId);
      if (creds instanceof Response) return creds;
      const { apiKey, authConfigId } = creds;

      return connectComposio(ctx, {
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
  // profile or a workspace's Plugins page). No workspace owns it — the connection
  // binds `{type:"user"}` and its `connection.json` lives under the user's
  // credential root. The callback lands the user on the Plugins page of
  // `returnWorkspaceId` when the body names one (reopening the chat on
  // `returnConversationId` when it names one too), else on `/profile/connectors`.
  app.post("/v1/composio-auth/initiate-identity", requireAuth(ctx.authOptions), async (c) => {
    const parsed = await parseInitiateRequest(c);
    if (parsed instanceof Response) return parsed;
    const { connectorId } = parsed;

    const userId = ctx.runtime.resolveRequestUserId(c.var.identity);
    const returnTarget = await resolveReturnTarget(ctx.workspaceStore, ctx.runtime, parsed, userId);
    if (returnTarget instanceof Response) return returnTarget;

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

    return connectComposio(ctx, {
      entry,
      connectorId,
      owner: { type: "user", userId },
      apiKey,
      authConfigId,
      returnTarget,
    });
  });

  // ── GET /v1/composio-auth/callback ────────────────────────────────
  app.get("/v1/composio-auth/callback", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");

    const validated = await validateCallbackParams(c);
    if (validated instanceof Response) return validated;
    const { connectedAccountId, status, cid, owner, returnTarget } = validated;

    const entry = await loadCallbackCatalogEntry(ctx, c, cid);
    if (entry instanceof Response) return entry;

    const composioUser = composioUserId(owner);
    // The redirect carries only the account id, so the account's label is one
    // bounded read. Awaited, not fired after the save: a late rewrite could land
    // after a Disconnect and put `connection.json` back.
    const { apiKey } = validateComposioConfig();
    const displayName = apiKey
      ? await getComposioAccountDisplayName({ apiKey, connectedAccountId })
      : undefined;
    const connection: ComposioConnection = {
      connectedAccountId,
      toolkit: entry.composio.toolkit,
      userId: composioUser,
      connectedAt: new Date().toISOString(),
      status,
      ...(displayName ? { displayName } : {}),
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

    // One-shot cookie — clear on success so the callback URL can't be
    // replayed.
    c.header("Set-Cookie", buildComposioStateCookie("", 0));

    // Back to the connectors page, naming what connected; the page confirms it.
    return c.redirect(connectorsReturnUrl(owner, returnTarget, slugifyServerName(cid)), 302);
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
    // Read from the validated cached config rather than re-reading the
    // raw source each request. The cached value has already passed the
    // http(s) protocol check at startup; reading the source directly
    // would bypass that guard if it mutated post-startup (unlikely in
    // production but cheap defense-in-depth).
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
): Promise<
  { connectorId: string; returnWorkspaceId: unknown; returnConversationId: unknown } | Response
> {
  let body: { connectorId?: unknown; returnWorkspaceId?: unknown; returnConversationId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const connectorId = typeof body.connectorId === "string" ? body.connectorId : "";
  if (!connectorId || !isValidConnectorId(connectorId)) {
    return apiError(400, "bad_request", "connectorId is required and must be a catalog id.");
  }
  return {
    connectorId,
    returnWorkspaceId: body.returnWorkspaceId,
    returnConversationId: body.returnConversationId,
  };
}

/** Load `connectorId` from the catalog and confirm it is Composio-backed, else an error Response. */
async function loadInitiateCatalogEntry(
  ctx: AppContext,
  connectorId: string,
): Promise<ComposioCatalogEntry | Response> {
  const directory = ctx.runtime.getConnectorCatalog();
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

/** Resolve the platform Composio API key and the connector's auth-config id, else an error Response. */
function resolveComposioCredentials(
  entry: ComposioCatalogEntry,
  connectorId: string,
  logCtx: string,
): { apiKey: string; authConfigId: string } | Response {
  // Platform-wide Composio broker credential. Single source for the whole
  // deployment; per-owner isolation lives in `user_id` (the Composio-side
  // identity, derived from the workspace or the user). A missing key is an
  // operator config error — surface a generic 500 and log specifics rather
  // than telling the API caller what to configure (the API isn't
  // operator-facing). `logCtx` is the owner label, for log context only.
  const { apiKey } = validateComposioConfig();
  if (!apiKey) {
    log.warn(
      "[composio-auth] no Composio broker credential configured " +
        "(connectors.providers.composio.apiKey / COMPOSIO_API_KEY); " +
        `cannot initiate connection for ${connectorId} (${logCtx})`,
    );
    return apiError(500, "composio_unconfigured", "Composio integration not configured.");
  }

  // Per-connector Composio `auth_config_id` (e.g. `ac_xxx`), operator-supplied
  // under `connectors.providers.composio.authConfigs`. It stays out of the
  // catalog because the id differs per Composio account while the catalog is
  // shared across deployments.
  const toolkit = entry.composio.toolkit;
  const authConfigId = composioAuthConfigId(toolkit);
  if (!authConfigId) {
    log.warn(
      `[composio-auth] no auth config id for toolkit "${toolkit}"; cannot initiate ${connectorId} (${logCtx})`,
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
  args: {
    entry: ComposioCatalogEntry;
    connectorId: string;
    owner: ConnectorOwner;
    apiKey: string;
    authConfigId: string;
    returnTarget?: ReturnTarget;
  },
): Promise<Response | null> {
  const { entry, connectorId, owner, apiKey, authConfigId, returnTarget } = args;
  const composioUser = composioUserId(owner);
  const ownerLabel = connectorOwnerKey(owner);
  // The chat-side `manageConnections` flow and an earlier explicit
  // click both create connected accounts here; without this dedup
  // we'd hit Composio's "Multiple connected accounts found … use
  // allowMultiple" error or pile up duplicates. We adopt the existing
  // account by writing our own connection.json against its id,
  // transitioning the connector state to `running`, and telling the SPA
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
          "Reconnect failed: the existing Composio account was found but the MCP source could not start. Try Sign out, then Connect again.",
        );
      }
      const connection: ComposioConnection = {
        connectedAccountId: existing.id,
        toolkit: entry.composio.toolkit,
        userId: composioUser,
        connectedAt: new Date().toISOString(),
        status: existing.status,
        ...(existing.displayName ? { displayName: existing.displayName } : {}),
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
      return json<ComposioInitiateResponse>({
        authorizationUrl: connectorsReturnUrl(owner, returnTarget),
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
  args: {
    entry: ComposioCatalogEntry;
    connectorId: string;
    owner: ConnectorOwner;
    apiKey: string;
    authConfigId: string;
    /** A personal connect's starting workspace and conversation, checked by the caller. */
    returnTarget?: ReturnTarget;
  },
): Promise<Response> {
  const adopted = await adoptExistingComposioConnection(ctx, args);
  if (adopted) return adopted;
  return initiateFreshComposioConnection({
    connectorId: args.connectorId,
    owner: args.owner,
    apiKey: args.apiKey,
    authConfigId: args.authConfigId,
    ...(args.returnTarget ? { returnTarget: args.returnTarget } : {}),
  });
}

/** Begin a fresh Composio OAuth connection: bind the state cookie and return the vendor authorization URL. */
async function initiateFreshComposioConnection(args: {
  connectorId: string;
  owner: ConnectorOwner;
  apiKey: string;
  authConfigId: string;
  returnTarget?: ReturnTarget;
}): Promise<Response> {
  const { connectorId, owner, apiKey, authConfigId, returnTarget } = args;
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
  // initiate leaves no orphan record. The record keeps the connected account
  // `link()` created: that account, not one the callback's query names, is the
  // one the callback persists. The browser binding's cookie goes only to this
  // caller (scoped to the callback path), and the record keeps only its hash.
  const binding = mintBrowserBinding();
  registerConnectFlow(nonce, {
    owner,
    connectorId,
    connectedAccountId: initiateResponse.connectedAccountId,
    bindingHash: binding.bindingHash,
    ...(returnTarget ? { returnWsId: returnTarget.wsId } : {}),
    ...(returnTarget?.conversationId ? { returnConversationId: returnTarget.conversationId } : {}),
  });

  return json<ComposioInitiateResponse>({ authorizationUrl: initiateResponse.redirectUrl }, 200, {
    "Set-Cookie": buildComposioStateCookie(binding.cookieValue, 900),
  });
}

/**
 * Validate the callback and return what to persist, or an error Response.
 *
 * Order matters. The nonce finds the flow, and the browser binding is checked
 * before anything else, so a request from a browser the initiate did not bind
 * neither completes nor ends someone else's flow. Once the binding verifies,
 * the flow is consumed whatever the outcome: a denied or failed callback
 * cannot be replayed with other parameters. The connected account is the one
 * the initiate recorded; the query's id is only a cross-check, and a callback
 * that names another account is refused.
 */
async function validateCallbackParams(c: Context<AppEnv>): Promise<
  | {
      connectedAccountId: string;
      status: string;
      cid: string;
      owner: ConnectorOwner;
      returnTarget?: ReturnTarget;
    }
  | Response
> {
  const nonce = c.req.query("n");
  if (!nonce) {
    return c.text("missing nonce", 400);
  }

  const pending = peekConnectFlow(nonce);
  if (!pending) {
    return errorPage(c, "<h3>Unknown or expired authorization flow.</h3>");
  }
  if (
    !browserBindingMatches(c.req.header("cookie"), COMPOSIO_STATE_COOKIE, [pending.bindingHash])
  ) {
    return errorPage(c, "<h3>Authorization session mismatch.</h3>");
  }
  // Bound to this browser: from here every outcome ends the flow.
  const flow = consumeConnectFlow(nonce);
  if (!flow) {
    return errorPage(c, "<h3>Unknown or expired authorization flow.</h3>");
  }

  const error = c.req.query("error");
  if (error) {
    c.header("Content-Security-Policy", ERROR_PAGE_CSP);
    return c.html(
      `<html><body><h3>Connection failed</h3><pre>${escapeHtml(error)}</pre></body></html>`,
      400,
    );
  }
  // A denied consent is reported by the hosted flow as `status=failed` with no
  // `error` param at all — verified against a real denial, which Composio
  // records as `FAILED / "Authorization was denied at the provider"`. Nothing
  // downstream re-checks this: the caller persists whatever status arrives, and
  // the gate that decides a connector is connected (`hasPersistedComposioConnection`)
  // tests only that the file exists. So without this the user would deny at the
  // vendor and still land on "Connection complete", with a connector wired to an
  // account that can never serve a tool call.
  //
  // Deny-listed rather than allow-listed on purpose: an unrecognised status
  // keeps today's behaviour, where an allow-list would turn one unseen success
  // spelling into "nobody can connect anything".
  const status = c.req.query("status") ?? "ACTIVE";
  if (FAILED_CALLBACK_STATUSES.has(status.trim().toLowerCase())) {
    c.header("Content-Security-Policy", ERROR_PAGE_CSP);
    return c.html(
      `<html><body><h3>Connection failed</h3><pre>${escapeHtml(status)}</pre>` +
        `${reinitiateParagraph()}</body></html>`,
      400,
    );
  }

  // Composio appends the account it created at initiate. Its absence means the
  // return did not come from a completed hosted flow; a different id is not
  // this flow's account. Either way nothing is persisted.
  const queryAccountId = c.req.query("connectedAccountId") ?? c.req.query("connected_account_id");
  if (!queryAccountId) {
    return c.text("missing connectedAccountId", 400);
  }
  if (queryAccountId !== flow.connectedAccountId) {
    log.warn("[composio-auth] callback named a connected account other than the flow's", {
      event: "composio_auth.callback",
      outcome: "account_mismatch",
      connector: flow.connectorId,
      owner: connectorOwnerKey(flow.owner),
    });
    return errorPage(c, "<h3>Connection does not match this authorization flow.</h3>");
  }

  const { connectorId: cid, owner, connectedAccountId, returnWsId, returnConversationId } = flow;
  if (!returnWsId) return { connectedAccountId, status, cid, owner };
  const returnTarget: ReturnTarget = returnConversationId
    ? { wsId: returnWsId, conversationId: returnConversationId }
    : { wsId: returnWsId };
  return { connectedAccountId, status, cid, owner, returnTarget };
}

/** A 400 error page with the restrictive CSP and the "connect again" hint. */
function errorPage(c: Context<AppEnv>, heading: string): Response {
  c.header("Content-Security-Policy", ERROR_PAGE_CSP);
  return c.html(`<html><body>${heading}${reinitiateParagraph()}</body></html>`, 400);
}

/** Load a callback `cid` from the catalog and confirm it is Composio-backed, else an error Response. */
async function loadCallbackCatalogEntry(
  ctx: AppContext,
  c: Context<AppEnv>,
  cid: string,
): Promise<ComposioCatalogEntry | Response> {
  const directory = ctx.runtime.getConnectorCatalog();
  const entry = await directory.catalogById(cid);
  if (entry?.auth !== "composio" || !entry.composio) {
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
  // this the UI would keep showing "Not connected" until the
  // next platform restart, even though tools were already callable.
  //
  // After a Disconnect → Connect cycle, `teardownConnectionSource`
  // has already removed the source from the registry — pure state
  // mutation isn't enough to recover. `ensureSourceRegistered` brings
  // the source back up from the persisted ConnectorRef if it's missing,
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

const COMPOSIO_STATE_COOKIE = "nb_composio_state";

/** Build the `__Host-nb_composio_state` flow cookie. */
function buildComposioStateCookie(value: string, maxAgeSeconds: number): string {
  return buildFlowCookie(COMPOSIO_STATE_COOKIE, value, maxAgeSeconds);
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
