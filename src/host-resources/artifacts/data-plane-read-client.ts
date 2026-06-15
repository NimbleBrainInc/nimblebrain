import {
  createMintingFetch,
  getDefaultServiceTokenCache,
  type ServiceTokenCache,
} from "../../oauth/tenant-key-mint.ts";

/**
 * Read client for the shared artifacts data plane.
 *
 * The host is an *unprivileged* client of the data plane, exactly like a
 * capability bundle — neither bypasses row-level security. The difference is
 * direction and privilege: a producing capability holds a write-only token; the
 * host holds a workspace-scoped *read* token and reads on behalf of the viewing
 * user. The single enforcement point is the data plane's RLS, keyed on
 * `(tenant, workspace)`. A guessed artifact id cannot cross a workspace because
 * the read token names the viewing user's workspace and RLS fences the row.
 *
 * Token minting reuses the runtime's existing tenant-key machinery
 * (`ServiceTokenCache` / `createMintingFetch`) — the same EdDSA-backed exchange
 * the runtime already uses to reach data-plane services. The runtime mints AS
 * its own tenant (read once from the deploy-provisioned env); the workspace
 * dimension comes from the request — never the wire, never the artifact URI.
 * There is no new signing key.
 *
 * Body delivery follows the data plane's own discrimination: small bodies are
 * returned inline (after the RLS row-read authorizes); large bodies are served
 * via a short-lived presigned URL the data plane mints *after* the same row-read
 * authorizes. The host prefers the presigned URL when offered — it keeps large
 * report bytes off the runtime's request path — and proxies inline bytes
 * otherwise.
 */

/** Audience of the artifacts data-plane service token. */
export const ARTIFACTS_AUDIENCE = "artifacts";
/** Read scope — least privilege; the host never holds write. */
export const ARTIFACTS_READ_SCOPE = "artifacts:read";

/** A resolved artifact body plus the metadata the renderer keys on. */
export interface ArtifactReadResult {
  /** RFC 6838 media type from the artifact's metadata row. */
  mimeType: string;
  /** Inline UTF-8 / binary body, when the data plane returned bytes directly. */
  body?: Uint8Array;
  /**
   * Short-lived presigned URL for a large body, when the data plane brokered
   * one instead of returning bytes. The host fetches it unauthenticated (the
   * URL itself carries the grant) and the bytes never pass through the runtime
   * twice.
   */
  presignedUrl?: string;
  /** Optional human title from the metadata row, for display. */
  title?: string;
  /** Size in bytes from the metadata row, when known. */
  sizeBytes?: number;
}

export class ArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`artifact "${id}" not found or not readable in this workspace`);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactReadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ArtifactReadError";
    this.status = status;
  }
}

export interface ArtifactDataPlaneConfig {
  /** Base URL of the artifacts data-plane service (the read API root). */
  baseUrl: string;
  /** mcp-authorizer issuer the tenant-key exchange mints against. */
  issuer: string;
}

/**
 * Resolve the artifacts data-plane endpoint + authorizer issuer from the
 * deploy-provisioned env. Mirrors `remote-transport.ts`'s posture: a missing
 * var is a hard, named error, because an artifact read is unreachable without
 * it and a downstream failure would not name the cause.
 */
export function readArtifactDataPlaneConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ArtifactDataPlaneConfig {
  const baseUrl = env.NB_ARTIFACTS_DATA_PLANE_URL;
  if (!baseUrl) {
    throw new ArtifactReadError(
      "NB_ARTIFACTS_DATA_PLANE_URL is not set; cannot resolve artifact:// references",
    );
  }
  const issuer = env.NB_FLEET_AUTHORIZER_ISSUER;
  if (!issuer) {
    throw new ArtifactReadError(
      "NB_FLEET_AUTHORIZER_ISSUER is not set; cannot mint an artifacts read token",
    );
  }
  return { baseUrl, issuer };
}

export interface ArtifactReadClientOptions {
  config?: ArtifactDataPlaneConfig;
  /** Token cache — defaults to the process-wide tenant-key cache. */
  cache?: ServiceTokenCache;
  /** Injectable fetch for tests; defaults to global. */
  fetchImpl?: typeof fetch;
}

/**
 * The shape returned by the data plane's read endpoint. A single JSON envelope
 * carries the metadata the host needs plus EITHER inline content OR a presigned
 * pointer — the host never has to interpret storage internals.
 */
interface DataPlaneReadEnvelope {
  mime_type?: unknown;
  mimeType?: unknown;
  title?: unknown;
  size_bytes?: unknown;
  sizeBytes?: unknown;
  /** base64-encoded inline body for small artifacts. */
  body_base64?: unknown;
  bodyBase64?: unknown;
  /** UTF-8 inline body for small text artifacts. */
  body_text?: unknown;
  bodyText?: unknown;
  /** Short-lived presigned URL for large artifacts. */
  presigned_url?: unknown;
  presignedUrl?: unknown;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function decodeBase64(b64: string): Uint8Array {
  // Node/Bun Buffer is available in the runtime; keep the decode here so the
  // resolver layer stays free of encoding concerns.
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export class ArtifactReadClient {
  private readonly config: ArtifactDataPlaneConfig;
  private readonly cache: ServiceTokenCache;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ArtifactReadClientOptions = {}) {
    this.config = opts.config ?? readArtifactDataPlaneConfigFromEnv();
    this.cache = opts.cache ?? getDefaultServiceTokenCache();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Read one artifact as the viewing user. `workspaceId` is the user's verified
   * workspace from the request — it scopes the minted read token and is the
   * dimension RLS fences on. A read for a workspace the user is not in (or an id
   * that lives in another workspace) is denied at the data plane and surfaces as
   * {@link ArtifactNotFoundError}; the host never distinguishes "absent" from
   * "forbidden", which would otherwise leak cross-workspace existence.
   */
  async read(id: string, workspaceId: string): Promise<ArtifactReadResult> {
    if (!workspaceId) {
      // Fail closed: a read with no workspace cannot be RLS-scoped. The data
      // plane would reject it, but naming the cause here is clearer.
      throw new ArtifactReadError("artifact read requires a workspace (the viewing user's)");
    }

    // Mint-and-attach a workspace-scoped read token via the existing tenant-key
    // exchange. The minting fetch re-mints on 401/403 (early expiry / rotation)
    // and never forwards any caller bearer — the token is service-plane,
    // identity-only, scoped to (tenant, workspace, aud=artifacts, read).
    const authedFetch = createMintingFetch({
      cache: this.cache,
      issuer: this.config.issuer,
      workspace: workspaceId,
      audience: ARTIFACTS_AUDIENCE,
      scope: ARTIFACTS_READ_SCOPE,
      baseFetch: this.fetchImpl,
    });

    const readUrl = new URL(
      `artifacts/${encodeURIComponent(id)}`,
      this.config.baseUrl.endsWith("/") ? this.config.baseUrl : `${this.config.baseUrl}/`,
    ).toString();

    let res: Response;
    try {
      res = await authedFetch(readUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (cause) {
      throw new ArtifactReadError(
        `artifact read request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    // 404 from the data plane covers both "no such row" and "RLS hid the row
    // from this workspace" — collapsed on purpose so a guessed id can't be used
    // to probe another workspace's inventory.
    if (res.status === 404 || res.status === 403) {
      throw new ArtifactNotFoundError(id);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ArtifactReadError(
        `artifact read for ${id} failed ${res.status}: ${detail.slice(0, 300)}`,
        res.status,
      );
    }

    let env: DataPlaneReadEnvelope;
    try {
      env = (await res.json()) as DataPlaneReadEnvelope;
    } catch {
      throw new ArtifactReadError("artifact read response was not JSON");
    }

    const mimeType = firstString(env.mime_type, env.mimeType) ?? "application/octet-stream";
    const title = firstString(env.title);
    const sizeRaw = env.size_bytes ?? env.sizeBytes;
    const sizeBytes = typeof sizeRaw === "number" && Number.isFinite(sizeRaw) ? sizeRaw : undefined;

    // Prefer the presigned URL when the data plane brokered one — that's the
    // large-body path, and it keeps the bytes off the runtime's request path.
    const presignedUrl = firstString(env.presigned_url, env.presignedUrl);
    if (presignedUrl) {
      return { mimeType, presignedUrl, title, sizeBytes };
    }

    // Otherwise the body is inline (small artifact). Accept either a base64
    // blob or a UTF-8 text body.
    const bodyBase64 = firstString(env.body_base64, env.bodyBase64);
    if (bodyBase64) {
      return { mimeType, body: decodeBase64(bodyBase64), title, sizeBytes };
    }
    const bodyText = firstString(env.body_text, env.bodyText);
    if (bodyText !== undefined) {
      return { mimeType, body: new TextEncoder().encode(bodyText), title, sizeBytes };
    }

    throw new ArtifactReadError(
      `artifact read for ${id} returned neither an inline body nor a presigned URL`,
    );
  }
}
