/**
 * `ComposioProvider` — Composio as one registered `ManagedConnectorProvider`.
 *
 * This is the adapter that presents Composio's brokered-auth + hosted-session
 * capabilities through the vendor-neutral seam. Every method delegates to the
 * `sdk.ts` helpers (which lazy-load `@composio/core` on first call), so
 * constructing the provider — and holding it in the registry — links no vendor.
 * The vendor loads only when a brokered call actually runs.
 *
 * The platform-wide broker credential is Composio's own detail: it is resolved
 * from the provider config here and injected into the underlying helpers, never
 * threaded through the seam's opts. So are Composio's *nouns* — the toolkit
 * slug, its tool allowlist, the auth-config id, the declared API-key fields,
 * and the `connection.json` under `credentials/composio/<connectorId>/`. The
 * kernel passes the catalog block through opaquely and asks only for verbs.
 */

import type { AppContext } from "../../../api/types.ts";
import type { ConnectorOwner } from "../../../identity/connector-owner.ts";
import { log } from "../../../observability/log.ts";
import type {
  BrokeredCleanupResult,
  BrokeredStateOptions,
  ConnectManagedApiKeyOptions,
  CreateManagedSessionOptions,
  ManagedConnectorProvider,
  ManagedSession,
} from "../managed-provider.ts";
import { parseComposioCatalogConfig } from "./catalog-config.ts";
import { composioAuthConfigId, validateComposioConfig } from "./config.ts";
import {
  type ComposioConnection,
  hasPersistedComposioConnection,
  readComposioConnection,
  saveComposioConnection,
} from "./connection.ts";
import { ComposioConnectionProbe } from "./connection-probe.ts";
import { COMPOSIO_PROVIDER_ID } from "./id.ts";
import { composioAuthRoutes } from "./routes.ts";
import {
  cleanupComposioBundle,
  composioUserId,
  connectComposioApiKey,
  createComposioSession,
  deleteComposioConnectedAccount,
  findActiveComposioConnection,
  initiateComposioConnection,
} from "./sdk.ts";
import { COMPOSIO_CREDENTIAL_PROVIDER } from "./transport-credential.ts";

/** The platform-wide Composio broker credential. Present by construction — the provider is built only when configured. */
function brokerApiKey(): string {
  return validateComposioConfig().apiKey;
}

/**
 * The operator-facing message for a toolkit with no auth-config id. Names the
 * config path to set, not the internals of how it is resolved.
 */
function authConfigMessage(toolkit: string): string {
  return (
    `Composio needs an auth config id for the "${toolkit}" toolkit. ` +
    "Create the auth config in the Composio dashboard, then set " +
    `connectors.providers.composio.authConfigs.${toolkit} in nimblebrain.json.`
  );
}

/**
 * Drop anything from the session's response headers that carries the broker
 * credential before the runtime persists them: the key is attached at
 * transport-build time by the `composio` credential provider, so the
 * `x-api-key` header itself — or a copy of the value inlined elsewhere — has no
 * business in `workspace.json`.
 *
 * The non-`x-api-key` branch guards a response shape we do not control: the
 * vendor could return the broker key embedded in some other header, and this is
 * the last step before the value is persisted. Dropping is lossier than
 * rewriting to a resolvable placeholder — that header is discarded rather than
 * kept — but keeping it would mean re-persisting a credential reference, which
 * is what the credential-provider seam removes. No live impact: Composio
 * returns only `x-api-key` today.
 */
function scrubSessionHeaders(
  headers: Record<string, string> | undefined,
  apiKey: string,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === "x-api-key") continue;
    if (apiKey && v.includes(apiKey)) continue;
    kept[k] = v;
  }
  return kept;
}

/**
 * Mint a hosted MCP session for one (owner, connector).
 *
 * Composio binds a session to a toolkit's auth config, so a missing
 * auth-config id is refused here — at Composio's own boundary — rather than by
 * the seam demanding an auth-config concept of every provider.
 */
async function createSession(opts: CreateManagedSessionOptions): Promise<ManagedSession> {
  const parsed = parseComposioCatalogConfig(opts.config);
  if ("error" in parsed) {
    throw new Error(`Composio install of "${opts.connectorId}": ${parsed.error}`);
  }
  const { toolkit, tools } = parsed.config;

  const authConfigId = composioAuthConfigId(toolkit);
  if (!authConfigId) throw new Error(authConfigMessage(toolkit));

  const apiKey = brokerApiKey();
  const session = await createComposioSession({
    apiKey,
    userId: opts.userId,
    toolkit,
    authConfigId,
    ...(tools && tools.length > 0 ? { tools } : {}),
  });

  const headers = scrubSessionHeaders(session.headers, apiKey);
  return {
    type: session.type,
    url: session.url,
    credentialProvider: COMPOSIO_CREDENTIAL_PROVIDER,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/**
 * Connect a toolkit that authenticates with a key rather than a redirect, and
 * record the resulting connection.
 *
 * Everything Composio-shaped about the flow lives here: which declared fields
 * are required, that unknown keys are refused, that the values are forwarded to
 * Composio and never persisted, that the resulting `connectedAccountId` lands in
 * `connection.json`, and that a replaced account is revoked afterwards.
 *
 * Per the seam's contract, a returned `{ error }` is a caller- or
 * operator-facing message safe to surface verbatim; a broker failure throws and
 * the caller genericizes it (so a rejected credential never echoes back what
 * was submitted).
 */
async function connectApiKey(
  opts: ConnectManagedApiKeyOptions,
): Promise<{ status: string } | { error: string }> {
  const parsed = parseComposioCatalogConfig(opts.config);
  if ("error" in parsed) return { error: parsed.error };
  const { toolkit, authScheme, fields: declared = [] } = parsed.config;

  if (authScheme !== "API_KEY") {
    return {
      error:
        `Connector "${opts.connectorId}" does not use API-key auth ` +
        `(authScheme=${authScheme}). Use the OAuth connect flow instead.`,
    };
  }
  if (declared.length === 0) {
    return { error: `Connector "${opts.connectorId}" declares no API-key fields to collect.` };
  }

  // Default-deny on the submitted shape: unknown keys are refused and only
  // declared keys are forwarded, so a caller cannot smuggle an extra field into
  // Composio's connection payload.
  const declaredKeys = new Set(declared.map((f) => f.key));
  for (const key of Object.keys(opts.fields)) {
    if (!declaredKeys.has(key)) {
      return { error: `Unknown field "${key}" for connector "${opts.connectorId}".` };
    }
  }
  const values: Record<string, string> = {};
  for (const field of declared) {
    const value = opts.fields[field.key]?.trim() ?? "";
    if (!value) {
      if (field.required !== false) {
        return { error: `Field "${field.key}" (${field.title}) is required.` };
      }
      continue;
    }
    values[field.key] = value;
  }

  const authConfigId = composioAuthConfigId(toolkit);
  if (!authConfigId) return { error: authConfigMessage(toolkit) };

  const userId = composioUserId(opts.owner);

  // Read the prior account BEFORE connecting: an API-key re-submit may carry a
  // rotated key, so the old account is REPLACED, not reused, and this is the id
  // to revoke once the replacement is persisted.
  const prior = await readComposioConnection(opts.workDir, opts.owner, opts.connectorId);

  const connected = await connectComposioApiKey({
    apiKey: brokerApiKey(),
    userId,
    authConfigId,
    fields: values,
  });

  const connection: ComposioConnection = {
    connectedAccountId: connected.connectedAccountId,
    toolkit,
    userId,
    connectedAt: new Date().toISOString(),
    status: connected.status,
  };
  await saveComposioConnection(opts.workDir, opts.owner, opts.connectorId, connection);

  await revokeReplacedAccount(prior, connected.connectedAccountId, opts.connectorId);

  return { status: connected.status };
}

/**
 * Rotation cleanup: revoke the account just replaced so a rotated-away key stops
 * being authorized at Composio and orphans don't accumulate. Runs after the new
 * account is persisted. Best-effort — `deleteComposioConnectedAccount` never
 * throws; on failure the prior key may linger at Composio until removed there.
 */
async function revokeReplacedAccount(
  prior: ComposioConnection | null,
  newAccountId: string,
  connectorId: string,
): Promise<void> {
  if (!prior?.connectedAccountId || prior.connectedAccountId === newAccountId) return;
  const revoked = await deleteComposioConnectedAccount({
    apiKey: brokerApiKey(),
    connectedAccountId: prior.connectedAccountId,
  });
  if (!revoked) {
    log.warn(
      `[composio] could not revoke the replaced connected account for ${connectorId}; ` +
        "the prior key may remain authorized until removed at Composio",
    );
  }
}

/**
 * Revoke the upstream connected account (the vendor's OAuth tokens go with it)
 * and drop the local `connection.json`, so a later Connect cannot short-circuit
 * on a stale ACTIVE account. Best-effort by the seam's contract.
 */
function cleanup(opts: BrokeredStateOptions): Promise<BrokeredCleanupResult> {
  return cleanupComposioBundle({
    workDir: opts.workDir,
    owner: opts.owner,
    connectorId: opts.brokered.connectorId,
  });
}

/**
 * A Composio connector carries static transport auth but STILL needs a
 * per-owner connect, so its readiness is the presence of `connection.json`, not
 * the transport's credential class.
 */
function hasConnection(opts: BrokeredStateOptions): boolean {
  return hasPersistedComposioConnection(opts.workDir, opts.owner, opts.brokered.connectorId);
}

/**
 * Build the Composio `ManagedConnectorProvider`. Called only when Composio is
 * configured (`buildManagedConnectorRegistry`), so the broker credential is
 * present. Reads the monitor switch once here — the same "resolve config once at
 * startup" contract the rest of the Composio config follows.
 */
export function createComposioProvider(): ManagedConnectorProvider {
  // The revalidator probe is Composio's, and the operator can disable JUST the
  // liveness sweep without disabling the connector's auth/session brokering.
  // When thrown, omit `probe` entirely so the runtime wires no probe for this
  // provider — keeping the revalidator wiring in `server.ts` fully
  // provider-agnostic.
  const { monitorEnabled } = validateComposioConfig();
  if (!monitorEnabled) {
    log.info(
      "[connection-revalidator] composio probe disabled " +
        "(connectors.providers.composio.monitorEnabled)",
    );
  }

  return {
    id: COMPOSIO_PROVIDER_ID,

    userId: (owner: ConnectorOwner) => composioUserId(owner),

    createSession,

    initiate: (opts) => initiateComposioConnection({ apiKey: brokerApiKey(), ...opts }),

    connectApiKey,

    findActive: (opts) => findActiveComposioConnection({ apiKey: brokerApiKey(), ...opts }),

    delete: (connectedAccountId) =>
      deleteComposioConnectedAccount({ apiKey: brokerApiKey(), connectedAccountId }),

    cleanup,

    hasConnection,

    ...(monitorEnabled ? { probe: (directory) => new ComposioConnectionProbe(directory) } : {}),

    routes: (ctx: AppContext) => composioAuthRoutes(ctx),
  };
}
