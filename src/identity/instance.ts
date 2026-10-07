import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveInstanceCredentialRefs } from "../tools/instance-credentials.ts";

const INSTANCE_FILE = "instance.json";

// ── Auth adapter union ──────────────────────────────────────────────

export interface OidcAuth {
  adapter: "oidc";
  issuer: string;
  clientId: string;
  allowedDomains: string[];
  /** JWKS URI override. If omitted, discovered via OIDC .well-known. */
  jwksUri?: string;
  /**
   * Emails of the org's owners, matched case-insensitively against the email
   * the provider verified. A listed user is an owner on every sign-in, and
   * `manage_users` refuses to demote or deactivate them: the list, not the
   * Users page, decides. It is where the first owner comes from, since only an
   * owner can make another.
   */
  owners?: string[];
}

export interface WorkosAuth {
  adapter: "workos";
  /** WorkOS Client ID (client_...). */
  clientId: string;
  /** WorkOS Organization ID — scopes auth to a specific customer org. */
  organizationId?: string;
  /** WorkOS API key — can also come from WORKOS_API_KEY env var. */
  apiKey?: string;
  /**
   * AuthKit subdomain for MCP OAuth (e.g., "myapp" → myapp.authkit.app).
   * When set, the /mcp endpoint accepts Bearer JWTs issued by AuthKit and
   * exposes /.well-known/oauth-protected-resource for MCP client discovery.
   */
  authkitDomain?: string;
  /**
   * WorkOS organization-membership role slugs that map to the app `admin`
   * role, matched case-insensitively. Omit to use the default
   * `["admin", "owner"]`; an explicit list REPLACES the defaults and must
   * contain at least one non-empty slug. Set this when your WorkOS org's admin
   * role carries a custom slug (e.g. `org-admin`) — otherwise it silently maps
   * to `member`. Any slug not listed maps to `member` (and is logged). Note:
   * `owner` is an app-internal elevation assigned via `manage_users`, not a
   * WorkOS-derived role; listing an `owner` slug here grants app `admin`, not
   * app `owner`.
   */
  adminRoleSlugs?: string[];
  /**
   * Client IDs of this operator's own apps that obtain tokens from AuthKit
   * (for example a chat-channel bridge). An AuthKit token whose signed
   * `client_id` claim is listed is first-party — admitted on every route,
   * gated by workspace membership, like the web login. Any other AuthKit token
   * is a resource token, valid only at the `/mcp/<wsId>` its `aud` names.
   * Omitted or empty, no AuthKit token is first-party. The audience never
   * decides this: a token any MCP client refreshes without a `resource`
   * carries the same `aud` as one of these apps' tokens.
   */
  firstPartyClientIds?: string[];
  /**
   * Emails of the org's owners, matched case-insensitively against the email
   * the provider verified. A listed user is an owner on every sign-in, and
   * `manage_users` refuses to demote or deactivate them: the list, not the
   * Users page, decides. It is where the first owner comes from, since only an
   * owner can make another.
   */
  owners?: string[];
}

/**
 * The dev identity provider: every request authenticates as one local
 * developer, with no credential checked. Chosen only by writing it here, so an
 * instance without `instance.json` has no provider at all rather than this one.
 */
export interface DevAuth {
  adapter: "dev";
}

export type AuthConfig = OidcAuth | WorkosAuth | DevAuth;

// ── Instance config ─────────────────────────────────────────────────

export interface InstanceConfig {
  auth: AuthConfig;
  integrations?: Record<string, unknown>;
  orgName?: string;
  orgId?: string;
}

// ── Validation ──────────────────────────────────────────────────────

const VALID_ADAPTERS = new Set(["dev", "oidc", "workos"]);

/** Return a defined string, throwing `fieldError` on a non-string; `undefined` passes through unchanged. */
function optionalString(value: unknown, fieldError: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(fieldError);
  return value;
}

/** Validate optional WorkOS admin-role slugs — an array of strings with at least one non-empty slug. */
function validateAdminRoleSlugs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string"))
    throw new Error("instance.json: workos auth 'adminRoleSlugs' must be an array of strings");
  // An explicit list replaces the defaults, so an empty or blank-only list
  // would mean "no slug grants admin" — almost always a mistake (it locks
  // out every WorkOS admin). Reject it loudly instead of silently falling
  // back to the defaults; omit the field to use ["admin", "owner"].
  if ((value as string[]).every((s) => s.trim() === ""))
    throw new Error(
      "instance.json: workos auth 'adminRoleSlugs' must contain at least one " +
        'non-empty slug (omit the field to use the default ["admin", "owner"])',
    );
  return value as string[];
}

/** Validate optional first-party client IDs — an array of strings; empty means none. */
function validateFirstPartyClientIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string"))
    throw new Error("instance.json: workos auth 'firstPartyClientIds' must be an array of strings");
  return value as string[];
}

/** Validate optional owner emails — an array of email addresses; empty means none. */
function validateOwners(value: unknown, adapter: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((s) => typeof s !== "string" || !s.includes("@") || s.trim() !== s)
  )
    throw new Error(`instance.json: ${adapter} auth 'owners' must be an array of email addresses`);
  return value as string[];
}

/** Validate and build an OIDC auth config, throwing on any missing or mistyped field. */
function buildOidcAuth(auth: Record<string, unknown>): OidcAuth {
  if (typeof auth.issuer !== "string")
    throw new Error("instance.json: oidc auth requires string 'issuer'");
  if (typeof auth.clientId !== "string")
    throw new Error("instance.json: oidc auth requires string 'clientId'");
  if (!Array.isArray(auth.allowedDomains))
    throw new Error("instance.json: oidc auth requires array 'allowedDomains'");
  const oidc: OidcAuth = {
    adapter: "oidc",
    issuer: auth.issuer as string,
    clientId: auth.clientId as string,
    allowedDomains: auth.allowedDomains as string[],
  };
  const jwksUri = optionalString(
    auth.jwksUri,
    "instance.json: oidc auth 'jwksUri' must be a string",
  );
  if (jwksUri !== undefined) oidc.jwksUri = jwksUri;
  const owners = validateOwners(auth.owners, "oidc");
  if (owners !== undefined) oidc.owners = owners;
  return oidc;
}

/** Validate and build a WorkOS auth config, throwing on any missing or mistyped field. */
function buildWorkosAuth(auth: Record<string, unknown>): WorkosAuth {
  if (typeof auth.clientId !== "string")
    throw new Error("instance.json: workos auth requires string 'clientId'");
  const workos: WorkosAuth = {
    adapter: "workos",
    clientId: auth.clientId as string,
  };
  const organizationId = optionalString(
    auth.organizationId,
    "instance.json: workos auth 'organizationId' must be a string",
  );
  // The provider reads a falsy organizationId as "no organization scope", so a
  // blank value would boot without the org gate. A config renderer that
  // interpolates an unset variable produces exactly that, so refuse it here and
  // keep "no organization" expressible only by omitting the field.
  if (organizationId !== undefined && organizationId.trim() === "")
    throw new Error(
      "instance.json: workos auth 'organizationId' must not be empty " +
        "(omit the field to run without an organization)",
    );
  if (organizationId !== undefined) workos.organizationId = organizationId;
  const apiKey = optionalString(
    auth.apiKey,
    "instance.json: workos auth 'apiKey' must be a string",
  );
  if (apiKey !== undefined) workos.apiKey = apiKey;
  const authkitDomain = optionalString(
    auth.authkitDomain,
    "instance.json: workos auth 'authkitDomain' must be a string",
  );
  if (authkitDomain !== undefined) workos.authkitDomain = authkitDomain;
  const adminRoleSlugs = validateAdminRoleSlugs(auth.adminRoleSlugs);
  if (adminRoleSlugs !== undefined) workos.adminRoleSlugs = adminRoleSlugs;
  const firstPartyClientIds = validateFirstPartyClientIds(auth.firstPartyClientIds);
  if (firstPartyClientIds !== undefined) workos.firstPartyClientIds = firstPartyClientIds;
  const owners = validateOwners(auth.owners, "workos");
  if (owners !== undefined) workos.owners = owners;
  return workos;
}

function validateAuthConfig(raw: unknown): AuthConfig {
  if (raw == null || typeof raw !== "object") {
    throw new Error("instance.json: auth must be an object");
  }
  const auth = raw as Record<string, unknown>;
  const adapter = auth.adapter;
  if (typeof adapter !== "string" || !VALID_ADAPTERS.has(adapter)) {
    throw new Error(
      `instance.json: unknown auth adapter "${String(adapter)}". Expected one of: ${[...VALID_ADAPTERS].join(", ")}`,
    );
  }

  if (adapter === "dev") return { adapter: "dev" };
  if (adapter === "oidc") return buildOidcAuth(auth);
  if (adapter === "workos") return buildWorkosAuth(auth);
  throw new Error(`instance.json: unknown auth adapter "${adapter}"`);
}

function validateInstanceConfig(raw: unknown): InstanceConfig {
  if (raw == null || typeof raw !== "object") {
    throw new Error("instance.json: root must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const auth = validateAuthConfig(obj.auth);

  const config: InstanceConfig = { auth };

  if (obj.integrations !== undefined) {
    if (typeof obj.integrations !== "object" || obj.integrations === null) {
      throw new Error("instance.json: integrations must be an object");
    }
    config.integrations = obj.integrations as Record<string, unknown>;
  }
  if (obj.orgName !== undefined) {
    if (typeof obj.orgName !== "string") throw new Error("instance.json: orgName must be a string");
    config.orgName = obj.orgName as string;
  }
  if (obj.orgId !== undefined) {
    if (typeof obj.orgId !== "string") throw new Error("instance.json: orgId must be a string");
    config.orgId = obj.orgId as string;
  }

  return config;
}

// ── Load / Save ─────────────────────────────────────────────────────

let tmpCounter = 0;
function uniqueTmpSuffix(): string {
  return `${Date.now()}.${++tmpCounter}`;
}

/**
 * Load instance config from `workDir/instance.json`.
 * Returns null if the file does not exist; `Runtime.start` then refuses to
 * start unless its caller passed a provider (`missingInstanceConfigError`).
 * Throws on malformed JSON or schema validation failure.
 */
export async function loadInstanceConfig(workDir: string): Promise<InstanceConfig | null> {
  const filePath = join(workDir, INSTANCE_FILE);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`instance.json: failed to parse JSON in ${filePath}`);
  }

  // Dereference credential references BEFORE validation: `apiKey` and its
  // neighbours are validated as strings, so a `{ ref: "credential", key }`
  // reaching the validator would be rejected as a mistyped field rather than
  // resolved. Same instance scope and same rule as `nimblebrain.json` — any
  // string field here may be a reference instead.
  return validateInstanceConfig(await resolveInstanceCredentialRefs(raw));
}

/**
 * The startup error for an instance with no `instance.json`. It names the file
 * and the two ways to write it, because a missing identity config never
 * defaults to one.
 */
export function missingInstanceConfigError(workDir: string): Error {
  const filePath = join(workDir, INSTANCE_FILE);
  return new Error(
    `No identity provider: ${filePath} does not exist, and the runtime does not start without one.\n` +
      `  Local development, every request as one developer with no login:\n` +
      `    {"auth":{"adapter":"dev"}}\n` +
      `  A real identity provider:\n` +
      `    {"auth":{"adapter":"oidc","issuer":"https://idp.example.com","clientId":"<client id>","allowedDomains":["example.com"]}}\n` +
      `    or {"auth":{"adapter":"workos","clientId":"<client id>"}}\n` +
      `  See https://docs.nimblebrain.ai/config/instance-json/`,
  );
}

/**
 * Atomically save instance config to `workDir/instance.json`.
 * Uses write-temp-then-rename to prevent partial writes.
 */
export async function saveInstanceConfig(workDir: string, config: InstanceConfig): Promise<void> {
  const filePath = join(workDir, INSTANCE_FILE);
  const tmpPath = `${filePath}.tmp.${uniqueTmpSuffix()}`;
  await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  await rename(tmpPath, filePath);
}
