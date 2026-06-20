/**
 * Upstream MCP registry `ServerDetail` shape — the canonical wire
 * format every `ConnectorRegistry` returns.
 *
 * The platform stopped authoring its own discovery shape: a static
 * curated catalog now ships entries that conform to upstream
 * [`ServerDetail`](../../src/connectors/schemas/server.schema.json), and
 * `MpakSource` reads the same shape natively from mpak's `/v1/servers/...`
 * via the SDK. Consumers always see one type. The `_meta` extension
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

/** A package the server is distributed as (mpak bundle, npm pkg, etc.). */
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
 * NimbleBrain-specific extension carried inside `ServerDetail._meta`
 * under the key `ai.nimblebrain/connector`. Holds the platform-specific
 * fields that don't fit upstream slots: OAuth flow type, operator-setup
 * pointers, recommended scope, search tags, and UI hints.
 *
 * Authored on entries we curate (loaded by `StaticSource` from the
 * curated catalog directory) and absent on mpak entries (the
 * projection leaves it undefined).
 */
export interface NimbleBrainConnectorMeta {
  /**
   * OAuth flow type for remote services.
   *
   * - `dcr`: dynamic client registration (RFC 7591). Provider issues
   *   a client at first use; no operator setup.
   * - `static`: pre-registered OAuth client. Operator provides
   *   `clientId` + `clientSecret` from the vendor's developer portal.
   * - `composio`: Composio aggregator holds the vendor's tokens.
   *   Platform persists only an opaque `connectedAccountId` per
   *   workspace. Required: the `composio` block below.
   * - `provider`: a platform-managed connector whose credential is produced
   *   server-side by a named credential provider (no user/operator OAuth, no
   *   per-user secret). Required: the `providerAuth` block below.
   */
  auth?: "dcr" | "static" | "composio" | "provider";
  /** Required for `auth: "static"`: where the operator creates the OAuth app. */
  operatorSetup?: {
    portalUrl: string;
    hint: string;
    clientSecretKey: string;
  };
  /**
   * Required for `auth: "composio"`. Names the toolkit at Composio
   * and the env var holding the operator-controlled auth-config id.
   *
   * - `toolkit`: Composio's slug for the upstream (`gmail`, `slack`,
   *   `hubspot`, …). Passed as the `authConfigs` key when calling
   *   `composio.create(userId, { authConfigs: { [toolkit]: ac_… } })`
   *   at install time, and used as the directory name for the
   *   per-workspace `connection.json`.
   * - `authConfigEnv`: name of the env var holding Composio's
   *   `auth_config_id` (e.g. `ac_…`). The catalog file is OSS and
   *   shared across deployments; the actual id varies per Composio
   *   account, hence the indirection.
   *
   * The MCP URL and headers are obtained from Composio's session API
   * at install time — operators do not pre-create an MCP server
   * config or specify a server id.
   *
   * `tools` is an optional allowlist of Composio tool slugs to expose
   * on the MCP endpoint. Required in practice for any toolkit with
   * more than ~20 tools: without it the agent's tool-discovery search
   * dumps every matching tool's full description into the context
   * (Outlook = 282 tools, ~225K tokens). Curate per connector to a
   * working set. Omit / leave empty for small toolkits.
   */
  composio?: {
    toolkit: string;
    authConfigEnv: string;
    tools?: string[];
  };
  /**
   * Required for `auth: "provider"`. Names the credential provider and its
   * opaque config — e.g. `{ provider: "minted", config: { audience, scope } }`.
   * Operator-authored; the install path copies it verbatim into the BundleRef
   * `transport.auth`. NEVER derived from tenant input.
   */
  providerAuth?: { provider: string; config: Record<string, unknown> };
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
