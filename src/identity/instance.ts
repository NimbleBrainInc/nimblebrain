import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INSTANCE_FILE = "instance.json";

// ── Auth adapter union ──────────────────────────────────────────────

export interface OidcAuth {
  adapter: "oidc";
  issuer: string;
  clientId: string;
  allowedDomains: string[];
  /** JWKS URI override. If omitted, discovered via OIDC .well-known. */
  jwksUri?: string;
}

export interface WorkosAuth {
  adapter: "workos";
  /** WorkOS Client ID (client_...). */
  clientId: string;
  /**
   * OAuth callback URL (e.g., https://app.example.com/v1/auth/callback).
   * Optional: when omitted the provider derives `${publicOrigin()}/v1/auth/callback`
   * from the canonical public origin. An explicit value (legacy
   * `WORKOS_REDIRECT_URI`) still overrides — kept as a fallback during the
   * migration off that secret.
   */
  redirectUri?: string;
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
}

export type AuthConfig = OidcAuth | WorkosAuth;

// ── Instance config ─────────────────────────────────────────────────

export interface InstanceConfig {
  auth: AuthConfig;
  integrations?: Record<string, unknown>;
  orgName?: string;
  orgId?: string;
}

// ── Validation ──────────────────────────────────────────────────────

const VALID_ADAPTERS = new Set(["oidc", "workos"]);

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

  switch (adapter) {
    case "oidc": {
      if (typeof auth.issuer !== "string")
        throw new Error("instance.json: oidc auth requires string 'issuer'");
      if (typeof auth.clientId !== "string")
        throw new Error("instance.json: oidc auth requires string 'clientId'");
      if (!Array.isArray(auth.allowedDomains)) {
        throw new Error("instance.json: oidc auth requires array 'allowedDomains'");
      }
      const oidc: OidcAuth = {
        adapter: "oidc",
        issuer: auth.issuer as string,
        clientId: auth.clientId as string,
        allowedDomains: auth.allowedDomains as string[],
      };
      if (auth.jwksUri !== undefined) {
        if (typeof auth.jwksUri !== "string")
          throw new Error("instance.json: oidc auth 'jwksUri' must be a string");
        oidc.jwksUri = auth.jwksUri as string;
      }
      return oidc;
    }

    case "workos": {
      if (typeof auth.clientId !== "string")
        throw new Error("instance.json: workos auth requires string 'clientId'");
      // redirectUri is optional — the provider derives it from publicOrigin()
      // when absent. Validate only if present.
      if (auth.redirectUri !== undefined && typeof auth.redirectUri !== "string")
        throw new Error("instance.json: workos auth 'redirectUri' must be a string");
      const workos: WorkosAuth = {
        adapter: "workos",
        clientId: auth.clientId as string,
      };
      if (auth.redirectUri !== undefined) {
        workos.redirectUri = auth.redirectUri as string;
      }
      if (auth.organizationId !== undefined) {
        if (typeof auth.organizationId !== "string")
          throw new Error("instance.json: workos auth 'organizationId' must be a string");
        workos.organizationId = auth.organizationId as string;
      }
      if (auth.apiKey !== undefined) {
        if (typeof auth.apiKey !== "string")
          throw new Error("instance.json: workos auth 'apiKey' must be a string");
        workos.apiKey = auth.apiKey as string;
      }
      if (auth.authkitDomain !== undefined) {
        if (typeof auth.authkitDomain !== "string")
          throw new Error("instance.json: workos auth 'authkitDomain' must be a string");
        workos.authkitDomain = auth.authkitDomain as string;
      }
      if (auth.adminRoleSlugs !== undefined) {
        if (
          !Array.isArray(auth.adminRoleSlugs) ||
          auth.adminRoleSlugs.some((s) => typeof s !== "string")
        )
          throw new Error(
            "instance.json: workos auth 'adminRoleSlugs' must be an array of strings",
          );
        // An explicit list replaces the defaults, so an empty or blank-only list
        // would mean "no slug grants admin" — almost always a mistake (it locks
        // out every WorkOS admin). Reject it loudly instead of silently falling
        // back to the defaults; omit the field to use ["admin", "owner"].
        if ((auth.adminRoleSlugs as string[]).every((s) => s.trim() === ""))
          throw new Error(
            "instance.json: workos auth 'adminRoleSlugs' must contain at least one " +
              'non-empty slug (omit the field to use the default ["admin", "owner"])',
          );
        workos.adminRoleSlugs = auth.adminRoleSlugs as string[];
      }
      return workos;
    }

    default:
      throw new Error(`instance.json: unknown auth adapter "${adapter}"`);
  }
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
 * Returns null if the file does not exist (dev mode signal).
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

  return validateInstanceConfig(raw);
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
