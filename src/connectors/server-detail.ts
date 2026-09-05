/**
 * Upstream MCP registry `ServerDetail` shape — the canonical wire
 * format every `ConnectorRegistry` returns.
 *
 * The platform stopped authoring its own discovery shape: a static
 * curated catalog ships entries that conform to upstream
 * [`ServerDetail`](../../src/connectors/schemas/server.schema.json), and any
 * future HTTP-backed source reads the same shape natively. Consumers always
 * see one type. The `_meta` extension
 * `ai.nimblebrain/connector` carries our platform-specific fields
 * (auth, operatorSetup, etc.) without polluting upstream-defined slots.
 *
 * Validated at every system boundary so an invalid entry is dropped
 * at the source it came from, never reaching the UI / agent. Each
 * `ServerDetail` is ajv-validated against the upstream JSON Schema
 * before it leaves a `ConnectorSource`; invalid entries are dropped
 * with a logged warning naming the source + entry name.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { HostManifestMeta } from "../bundles/types.ts";
import type { CredentialRef } from "../tools/credential-ref.ts";
import type { ConnectorAuthKind } from "./auth-kind.ts";

/** Optional sized icon. Upstream Icon definition. */
export interface Icon {
  src: string;
  mimeType?: "image/png" | "image/jpeg" | "image/jpg" | "image/svg+xml" | "image/webp";
  sizes?: string[];
  theme?: "light" | "dark";
}

/** Repository metadata. Upstream Repository definition. */
export interface Repository {
  url: string;
  source: string;
  id?: string;
  subfolder?: string;
}

/** Stdio transport (no command/args at the wire — those live on the bundle). */
export interface StdioTransport {
  type: "stdio";
}

/** Streamable HTTP transport (the MCP-over-HTTP profile). */
export interface StreamableHttpTransport {
  type: "streamable-http";
  url: string;
  headers?: KeyValueInput[];
}

/** Server-Sent Events transport (legacy MCP-over-SSE profile). */
export interface SseTransport {
  type: "sse";
  url: string;
  headers?: KeyValueInput[];
}

export type LocalTransport = StdioTransport | StreamableHttpTransport | SseTransport;
export type RemoteTransport = (StreamableHttpTransport | SseTransport) & {
  variables?: Record<string, Input>;
};

/** Free-form input definition shared by env vars / args / variables. */
export interface Input {
  description?: string;
  default?: string;
  format?: "string" | "number" | "boolean" | "filepath";
  isRequired?: boolean;
  isSecret?: boolean;
  placeholder?: string;
  value?: string;
  choices?: string[];
}

/** Input that names a key (env var name, header name). */
export interface KeyValueInput extends Input {
  name: string;
  variables?: Record<string, Input>;
}

/**
 * A package the server is distributed as (npm pkg, PyPI dist, etc.). Read for
 * display and scope-matching only: a package is code to download and run, and
 * this runtime installs nothing — an entry offering only packages is not
 * installable here.
 */
export interface Package {
  registryType: string;
  identifier: string;
  transport: LocalTransport;
  version?: string;
  registryBaseUrl?: string;
  fileSha256?: string;
  runtimeHint?: string;
  runtimeArguments?: unknown[];
  packageArguments?: unknown[];
  environmentVariables?: KeyValueInput[];
}

/**
 * A single field collected from the connecting user for a non-redirect
 * Composio auth scheme (API key, bearer token, basic auth) — the form the
 * platform renders in place of the OAuth consent bounce.
 *
 * `key` is the **Composio connection-initiation field name** — the key that
 * lands in the connected account's `val` when the platform calls
 * `connectedAccounts.initiate`. It must match what Composio expects for the
 * toolkit + scheme (verify via the SDK's `getConnectedAccountInitiationFields`
 * or the toolkit's auth page on composio.dev). Example for PostHog: `api_key`
 * + `subdomain`.
 *
 * This is NOT a NimbleBrain-side credential. The value is handed to Composio
 * at connect time and never persisted by the platform — the same trust
 * posture as the OAuth path, which keeps only the opaque `connectedAccountId`.
 */
export interface ComposioConnectField {
  key: string;
  title: string;
  description?: string;
  /** Hide the value in the UI and redact it from logs (passwords, API keys). */
  sensitive?: boolean;
  required?: boolean;
  placeholder?: string;
}

/**
 * Composio connector config. Single source of truth for the shape carried in
 * the connector `_meta` and threaded verbatim through the install action and
 * directory entry (previously duplicated inline across three files).
 *
 * - `toolkit`: Composio's slug for the upstream (`gmail`, `posthog`, …).
 *   Passed as the `authConfigs` key to `composio.create(...)` at install and
 *   used as the directory name for the per-workspace `connection.json`.
 * - `tools`: optional allowlist of Composio tool slugs to expose. Required in
 *   practice for any toolkit with more than ~20 tools (the agent's tool-search
 *   dumps every match's full description into context otherwise).
 * - `authScheme`: how the user connects. Defaults to `OAUTH2` (the redirect
 *   flow) when omitted — the historical behavior, so existing entries are
 *   unchanged. `API_KEY` (and other non-redirect schemes) skip the OAuth
 *   dance: the platform collects `fields` from the user, hands them to
 *   Composio at connect time, and persists only the `connectedAccountId`.
 * - `fields`: required for non-redirect `authScheme`s — what to collect from
 *   the connecting user. Omitted/empty for `OAUTH2`.
 */
export interface ComposioConnectorConfig {
  toolkit: string;
  tools?: string[];
  authScheme?: "OAUTH2" | "API_KEY";
  fields?: ComposioConnectField[];
}

/**
 * Config for an `auth: "smithery"` connector — carried on the connector `_meta`
 * and threaded verbatim through the install action and directory entry.
 *
 * - `server`: the Smithery registry qualified name (`nimblebrain/bassethound`).
 *   Handed to Smithery's Connect API as the connection target; Smithery resolves
 *   it to the deployed endpoint, so the catalog never names an MCP URL.
 *
 * Deliberately one field. Smithery needs no per-deployment env indirection (a
 * qualified name is global, unlike Composio's per-account `auth_config_id`) and
 * no tool allowlist (the connection exposes the server's own surface).
 */
export interface SmitheryConnectorConfig {
  server: string;
}

/**
 * One entry of a connector's {@link NimbleBrainConnectorMeta.secretHeaders} — a
 * credential reference, plus the two optional strings that let the operator say
 * what the value is in words a person recognises.
 *
 * The reference alone names a header and a store key, and neither is a label: a
 * user asked for `acme.db_url` on `X-Db-Url` is being asked in the catalog's
 * vocabulary. The collection dialog derives a readable default from the key's
 * last segment, so an entry that sets neither still asks a usable question;
 * `label` and `help` are how an entry says it better than the derivation can.
 *
 * Both are display-only. Neither reaches the transport, the store, or the
 * persisted ref — the header carries the resolved value and nothing else.
 */
export interface SecretHeaderRef extends CredentialRef {
  /** What to call this value, e.g. "Database connection string". */
  label?: string;
  /** One line of guidance — where to find the value, what format it takes. */
  help?: string;
}

/**
 * NimbleBrain-specific extension carried inside `ServerDetail._meta`
 * under the key `ai.nimblebrain/connector`. Holds the platform-specific
 * fields that don't fit upstream slots: OAuth flow type, operator-setup
 * pointers, recommended scope, search tags, and UI hints.
 *
 * Authored on entries we curate (loaded by `StaticSource` from the
 * curated catalog directory) and absent on entries from a registry that
 * doesn't carry it (the projection leaves it undefined).
 */
export interface NimbleBrainConnectorMeta {
  /**
   * How this connector authenticates. Either a runtime-native kind — the
   * runtime is the OAuth client or credential holder — or the id of a
   * registered brokered provider.
   *
   * Runtime-native ({@link RUNTIME_NATIVE_AUTH_KINDS}):
   * - `dcr`: dynamic client registration (RFC 7591). Provider issues
   *   a client at first use; no operator setup.
   * - `static`: pre-registered OAuth client. Operator provides
   *   `clientId` + `clientSecret` from the vendor's developer portal.
   * - `provider`: a platform-managed connector whose credential is produced
   *   server-side by a named credential provider (no user/operator OAuth, no
   *   per-user secret). Required: the `providerAuth` block below.
   *
   * Anything else names a **brokered** provider (`composio`, `smithery`) — a
   * third party that holds the upstream credential and hosts the MCP session.
   * It is validated against the registered providers when the install runs, not
   * against a literal union here: a deployment that has not configured a
   * broker still shows its connectors in Browse and refuses at install, rather
   * than having them vanish depending on deploy config.
   *
   * **A brokered entry carries its provider's config block under the key
   * naming that provider** — `composio:` / `smithery:` below. That convention
   * is what lets the install path hand a provider its own coordinates without
   * knowing what they are; the two typed blocks are documentation of the shapes
   * we ship, not an enumeration the runtime enforces.
   */
  auth?: ConnectorAuthKind;
  /** Required for `auth: "static"`: where the operator creates the OAuth app. */
  operatorSetup?: {
    portalUrl: string;
    hint: string;
    clientSecretKey: string;
  };
  /**
   * Composio's block, for `auth: "composio"`. See {@link ComposioConnectorConfig}
   * for the full shape (toolkit, tools, authScheme, fields).
   *
   * The MCP URL and headers are obtained from Composio's session API at
   * install time — operators do not pre-create an MCP server config or
   * specify a server id.
   */
  composio?: ComposioConnectorConfig;
  /**
   * Smithery's block, for `auth: "smithery"`. See {@link SmitheryConnectorConfig}.
   *
   * The MCP URL and headers come from Smithery's Connect API at install time —
   * operators name the registry server, not an endpoint.
   */
  smithery?: SmitheryConnectorConfig;
  /**
   * Required for `auth: "provider"`. Names the credential provider and its
   * opaque config — e.g. `{ provider: "minted", config: { audience, scope } }`.
   * Operator-authored; the install path copies it verbatim into the BundleRef
   * `transport.auth`. NEVER derived from tenant input.
   */
  providerAuth?: { provider: string; config: Record<string, unknown> };
  /**
   * Secrets the WORKSPACE owns, bound to outgoing request headers — a customer's
   * own database URL, an API key the customer holds. Each value is a
   * {@link SecretHeaderRef} into that workspace's credential store, so one catalog
   * entry installs into two workspaces and each sends its own value, and rotation
   * is a `put` on the key rather than a catalog change.
   *
   * Only references are accepted, never a literal: a catalog file is operator-
   * authored configuration in git, and a secret written there is exactly the copy
   * the credential store exists to prevent.
   *
   * This is NOT how the connection authenticates — `providerAuth` is. A fleet
   * entry keeps `provider: "minted"` (the identity the edge verifies) and carries
   * the customer's secret here, because the two answer different questions: who
   * is calling, and what that caller may open. The reference is read from the
   * trusted catalog entry into the BundleRef's `transport.headers`, where the
   * transport resolves it per connection at the connection's workspace scope;
   * `label` / `help` stay behind, since they are for the person being asked.
   */
  secretHeaders?: Record<string, SecretHeaderRef>;
  /** Optional OAuth scopes the bundle requests. */
  requiredScopes?: string[];
  /** Optional extra authorize-URL params (e.g. Google's access_type=offline). */
  additionalAuthorizationParams?: Record<string, string>;
  /** Search/filter tags surfaced on the Browse card. */
  tags?: string[];
  /** Marks the connector as exposing a UI surface — sets the "Interactive" badge. */
  interactive?: boolean;
  /** Optional connector-specific docs URL surfaced on the Configure page. */
  docsUrl?: string;
  /**
   * Offer this connector for PERSONAL (identity-plane) connection — the curated
   * set surfaced on the profile's Connectors page. Only DCR connectors are
   * actually installable on the identity plane today, so a non-DCR entry flagged
   * `personal` is still filtered out server-side (`list_personal_catalog`); the
   * flag is the operator's opt-in, the auth check is the hard gate.
   */
  personal?: boolean;
}

/** The canonical wire format. Upstream `ServerDetail`. */
export interface ServerDetail {
  name: string;
  description: string;
  version: string;
  $schema?: string;
  title?: string;
  websiteUrl?: string;
  repository?: Repository;
  icons?: Icon[];
  packages?: Package[];
  remotes?: RemoteTransport[];
  _meta?: Record<string, unknown> & {
    "ai.nimblebrain/connector"?: NimbleBrainConnectorMeta;
    "ai.nimblebrain/host"?: HostManifestMeta;
  };
}

/** Reverse-DNS namespace key for our `_meta` extension. */
export const NIMBLEBRAIN_CONNECTOR_META_KEY = "ai.nimblebrain/connector";

/** Convenience accessor with the right type narrowing. */
export function getNimbleBrainConnectorMeta(s: ServerDetail): NimbleBrainConnectorMeta | undefined {
  return s._meta?.[NIMBLEBRAIN_CONNECTOR_META_KEY] as NimbleBrainConnectorMeta | undefined;
}

/**
 * Reverse-DNS namespace key for the host-integration `_meta` extension —
 * how a server declares its UI placement in the NimbleBrain host shell.
 * Same key whether the descriptor is an MCPB manifest (bundles) or a
 * `ServerDetail` (fleet connectors). See schemas.nimblebrain.ai/v1/nimblebrain-host.schema.json.
 */
export const NIMBLEBRAIN_HOST_META_KEY = "ai.nimblebrain/host";

/** Convenience accessor for the host-integration extension. */
export function getNimbleBrainHostMeta(s: ServerDetail): HostManifestMeta | undefined {
  return s._meta?.[NIMBLEBRAIN_HOST_META_KEY] as HostManifestMeta | undefined;
}

/**
 * The connector-skill identity rule, over the two values that determine it.
 * Identity is a FLAT connector slug — a gmail connector is `gmail` whether it
 * is Composio-backed or a remote MCP server. For a Composio connector that is
 * the toolkit slug (stable across deployments, unlike the per-account auth
 * config id); otherwise it is the connector segment of the reverse-DNS server
 * name (`com.notion/mcp` -> `notion`, `app.linear/mcp` -> `linear`). Shared by
 * {@link connectorSkillIdentity} (ServerDetail callers) and the install path
 * (which has the toolkit + server name directly, not a ServerDetail).
 *
 * The non-Composio rule takes the LAST dotted label before the path, which fits
 * our curated first-party forms (`com.notion`, `app.linear`). It would derive
 * `<org>` (not `<server>`) from the registry-standard `io.github.<org>/<server>`
 * form — harmless today (overlays exist only for curated first-party connectors
 * and a wrong slug is a non-fatal 404), but revisit if an
 * `io.github.*`-style connector ever needs an overlay.
 */
export function connectorSkillIdentityFrom(
  composioToolkit: string | undefined,
  serverName: string,
): string {
  const toolkit = composioToolkit?.trim();
  if (toolkit) return toolkit;
  return serverName.split("/")[0]?.split(".").pop() || serverName;
}

/**
 * Stable identity used to look up a curated connector-skill overlay in the
 * public overlay repo, laid out as `<identity>/SKILL.md`. See
 * {@link connectorSkillIdentityFrom} for the rule. `name` is required on
 * `ServerDetail`, so a usable identity is always derivable.
 */
export function connectorSkillIdentity(detail: ServerDetail): string {
  return connectorSkillIdentityFrom(
    getNimbleBrainConnectorMeta(detail)?.composio?.toolkit,
    detail.name,
  );
}

// ── ajv validator (compiled once at module load) ────────────────────

const schemaPath = join(import.meta.dir, "schemas", "server.schema.json");
const schemaJson = JSON.parse(readFileSync(schemaPath, "utf-8")) as object;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const _validate = ajv.compile(schemaJson) as ValidateFunction<ServerDetail>;

/** Result of validating a candidate against the upstream schema. */
export interface ServerDetailValidation {
  valid: boolean;
  errors: string[];
}

/** Validate a candidate ServerDetail against the upstream schema. */
export function validateServerDetail(candidate: unknown): ServerDetailValidation {
  const ok = _validate(candidate);
  if (ok) return { valid: true, errors: [] };
  const errors = (_validate.errors ?? []).map((e) =>
    `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
  );
  return { valid: false, errors };
}
