/**
 * Upstream MCP registry `ServerDetail` shape — the canonical wire
 * format every `ConnectorRegistry` returns.
 *
 * The platform stopped authoring its own discovery shape: a static
 * curated catalog now ships entries that conform to upstream
 * [`ServerDetail`](../../src/connectors/schemas/server.schema.json), and
 * the mpak adapter projects mpak's legacy `/v1/bundles/...` JSON to the
 * same shape. Consumers always see one type. The `_meta` extension
 * `ai.nimblebrain/connector` carries our platform-specific fields
 * (defaultScope, auth, operatorSetup, etc.) without polluting
 * upstream-defined slots.
 *
 * Validation runs at every system boundary (per spec §1.3): every
 * `ServerDetail` produced by a registry is ajv-validated against the
 * upstream schema before it reaches the UI / agent. Invalid entries
 * are dropped with a logged warning naming source + entry name.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

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
 * Authored on entries we curate (StaticRegistry) and absent on mpak
 * entries (the projection leaves it undefined).
 */
export interface NimbleBrainConnectorMeta {
  /** Recommended OAuth identity scope for the connector. */
  defaultScope?: "workspace" | "user";
  /** OAuth flow type for remote services. */
  auth?: "dcr" | "static";
  /** Required for `auth: "static"`: where the operator creates the OAuth app. */
  operatorSetup?: {
    portalUrl: string;
    hint: string;
    clientSecretKey: string;
  };
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
  };
}

/** Reverse-DNS namespace key for our `_meta` extension. */
export const NIMBLEBRAIN_CONNECTOR_META_KEY = "ai.nimblebrain/connector";

/** Convenience accessor with the right type narrowing. */
export function getNimbleBrainConnectorMeta(s: ServerDetail): NimbleBrainConnectorMeta | undefined {
  return s._meta?.[NIMBLEBRAIN_CONNECTOR_META_KEY] as NimbleBrainConnectorMeta | undefined;
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
