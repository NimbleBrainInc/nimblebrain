import {
  createMintingFetch,
  getDefaultServiceTokenCache,
  resolveAuthorizerTokenUrl,
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
 * Body delivery follows the data plane's own two-endpoint shape. Metadata
 * (`GET /v1/artifacts/{id}`) returns a JSON row — mime type, title, size — with
 * no bytes. The body is fetched separately (`GET /v1/artifacts/{id}/content`),
 * which
 * after the RLS row-read authorizes either streams the bytes directly (small,
 * inline body) or answers a short-lived presigned-URL redirect (large body, the
 * data plane mints the URL *after* the same row-read). The host follows that
 * discrimination: it reads inline bytes off the content response, and for the
 * redirect it captures the presigned URL and fetches it off the read path so
 * large report bytes never traverse the runtime twice. The redirect is read
 * manually — the runtime's read bearer is never replayed to the storage origin.
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
  /** Authorizer token endpoint (POST target) the tenant-key exchange mints against. */
  tokenUrl: string;
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
  const tokenUrl = resolveAuthorizerTokenUrl({
    tokenUrl: env.NB_FLEET_AUTHORIZER_TOKEN_URL,
    issuer: env.NB_FLEET_AUTHORIZER_ISSUER,
  });
  if (!tokenUrl) {
    throw new ArtifactReadError(
      "authorizer token endpoint is not set; cannot mint an artifacts read token (set NB_FLEET_AUTHORIZER_TOKEN_URL, or NB_FLEET_AUTHORIZER_ISSUER for the legacy `${issuer}/token` fallback)",
    );
  }
  return { baseUrl, tokenUrl };
}

export interface ArtifactReadClientOptions {
  config?: ArtifactDataPlaneConfig;
  /** Token cache — defaults to the process-wide tenant-key cache. */
  cache?: ServiceTokenCache;
  /** Injectable fetch for tests; defaults to global. */
  fetchImpl?: typeof fetch;
}

/**
 * The metadata row returned by `GET /v1/artifacts/{id}`. Bytes are NOT here — the
 * body is fetched from `/content`. Snake_case mirrors the data plane's wire;
 * camelCase variants are accepted defensively so a future wire tweak does not
 * silently drop the field.
 */
interface ArtifactMetadataEnvelope {
  mime_type?: unknown;
  mimeType?: unknown;
  title?: unknown;
  size_bytes?: unknown;
  sizeBytes?: unknown;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

/** A row from `GET /v1/artifacts` — metadata only, no bytes. */
export interface ArtifactListItem {
  artifactId: string;
  uri: string;
  type: string;
  mimeType: string;
  title?: string;
  source: string;
  sizeBytes?: number;
  status: string;
  createdAt: string;
}

/** Result of {@link ArtifactReadClient.list} — a page + an opaque keyset cursor. */
export interface ArtifactListResult {
  items: ArtifactListItem[];
  nextCursor?: string;
}

/** Filters for {@link ArtifactReadClient.list}. */
export interface ArtifactListOptions {
  /** Semantic type filter — the producing capability's artifact type. */
  type?: string;
  /** Page size (data-plane-capped). */
  limit?: number;
  /** Keyset cursor from a prior call's `nextCursor`. */
  cursor?: string;
}

/** The list wire envelope; snake_case mirrors the data plane, camelCase accepted defensively. */
interface ArtifactListRowEnvelope {
  artifact_id?: unknown;
  artifactId?: unknown;
  uri?: unknown;
  type?: unknown;
  mime_type?: unknown;
  mimeType?: unknown;
  title?: unknown;
  source?: unknown;
  size_bytes?: unknown;
  sizeBytes?: unknown;
  status?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
}
interface ArtifactListEnvelope {
  artifacts?: ArtifactListRowEnvelope[];
  next_cursor?: unknown;
  nextCursor?: unknown;
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
      tokenUrl: this.config.tokenUrl,
      workspace: workspaceId,
      audience: ARTIFACTS_AUDIENCE,
      scope: ARTIFACTS_READ_SCOPE,
      baseFetch: this.fetchImpl,
    });

    // `baseUrl` is the service ROOT; the versioned API lives under `/v1/artifacts`
    // (the same convention the writer client appends in code), so one env var
    // means the same thing for the reader and the writer.
    const root = this.config.baseUrl.replace(/\/+$/, "");
    const encodedId = encodeURIComponent(id);
    const metaUrl = `${root}/v1/artifacts/${encodedId}`;
    const contentUrl = `${root}/v1/artifacts/${encodedId}/content`;

    // (1) Metadata row — mime type, title, size. No bytes here; the body comes
    // from the /content endpoint below.
    let metaRes: Response;
    try {
      metaRes = await authedFetch(metaUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (cause) {
      throw new ArtifactReadError(
        `artifact read request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    // 404/403 covers both "no such row" and "RLS hid the row from this
    // workspace" — collapsed on purpose so a guessed id can't be used to probe
    // another workspace's inventory.
    if (metaRes.status === 404 || metaRes.status === 403) {
      throw new ArtifactNotFoundError(id);
    }
    if (!metaRes.ok) {
      const detail = await metaRes.text().catch(() => "");
      throw new ArtifactReadError(
        `artifact read for ${id} failed ${metaRes.status}: ${detail.slice(0, 300)}`,
        metaRes.status,
      );
    }

    let meta: ArtifactMetadataEnvelope;
    try {
      meta = (await metaRes.json()) as ArtifactMetadataEnvelope;
    } catch {
      throw new ArtifactReadError("artifact metadata response was not JSON");
    }

    const mimeType = firstString(meta.mime_type, meta.mimeType) ?? "application/octet-stream";
    const title = firstString(meta.title);
    const sizeRaw = meta.size_bytes ?? meta.sizeBytes;
    const sizeBytes = typeof sizeRaw === "number" && Number.isFinite(sizeRaw) ? sizeRaw : undefined;

    // (2) Body. The data plane streams a small inline body directly (200) or
    // answers a redirect to a short-lived presigned URL for a large (spilled)
    // body. Read the redirect MANUALLY so the runtime's read bearer is never
    // replayed to the storage origin and so the presigned URL stays off the
    // read path (the resolver fetches it unauthenticated).
    let contentRes: Response;
    try {
      contentRes = await authedFetch(contentUrl, {
        method: "GET",
        redirect: "manual",
      });
    } catch (cause) {
      throw new ArtifactReadError(
        `artifact content request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (contentRes.status === 404 || contentRes.status === 403) {
      throw new ArtifactNotFoundError(id);
    }

    // Redirect → large body: capture the presigned URL and hand it up. The
    // resolver fetches it directly, keeping the bytes off the runtime path.
    if (contentRes.status >= 300 && contentRes.status < 400) {
      const presignedUrl = contentRes.headers.get("location") ?? undefined;
      if (presignedUrl) {
        return { mimeType, presignedUrl, title, sizeBytes };
      }
      throw new ArtifactReadError(
        `artifact content for ${id} redirected without a Location`,
        contentRes.status,
      );
    }

    if (!contentRes.ok) {
      const detail = await contentRes.text().catch(() => "");
      throw new ArtifactReadError(
        `artifact content for ${id} failed ${contentRes.status}: ${detail.slice(0, 300)}`,
        contentRes.status,
      );
    }

    // 200 → small inline body, streamed as raw bytes.
    const body = new Uint8Array(await contentRes.arrayBuffer());
    return { mimeType, body, title, sizeBytes };
  }

  /**
   * List artifacts as the viewing user (discovery for retrieval). `workspaceId`
   * scopes the minted read token and is the RLS dimension — the page only ever
   * contains the caller's own workspace's rows. Metadata only (no bytes); read a
   * row's body with {@link read}. Filters/pagination map straight onto
   * `GET /v1/artifacts`, which orders newest-first (`created_at` descending) and
   * keysets on `created_at` — the order the `list_artifacts` tool surfaces.
   */
  async list(workspaceId: string, opts: ArtifactListOptions = {}): Promise<ArtifactListResult> {
    if (!workspaceId) {
      throw new ArtifactReadError("artifact list requires a workspace (the viewing user's)");
    }
    const authedFetch = createMintingFetch({
      cache: this.cache,
      tokenUrl: this.config.tokenUrl,
      workspace: workspaceId,
      audience: ARTIFACTS_AUDIENCE,
      scope: ARTIFACTS_READ_SCOPE,
      baseFetch: this.fetchImpl,
    });

    const root = this.config.baseUrl.replace(/\/+$/, "");
    const params = new URLSearchParams();
    if (opts.type) params.set("type", opts.type);
    // Only forward a positive limit. A negative/zero is a caller error; drop it
    // (the data plane applies its default page size) rather than forwarding a
    // value the wire would reject or mishandle.
    if (typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit >= 1) {
      params.set("limit", String(Math.trunc(opts.limit)));
    }
    if (opts.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    const url = `${root}/v1/artifacts${qs ? `?${qs}` : ""}`;

    let res: Response;
    try {
      res = await authedFetch(url, { method: "GET", headers: { Accept: "application/json" } });
    } catch (cause) {
      throw new ArtifactReadError(
        `artifact list request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ArtifactReadError(
        `artifact list failed ${res.status}: ${detail.slice(0, 300)}`,
        res.status,
      );
    }

    let data: ArtifactListEnvelope;
    try {
      data = (await res.json()) as ArtifactListEnvelope;
    } catch {
      throw new ArtifactReadError("artifact list response was not JSON");
    }

    const rows = Array.isArray(data.artifacts) ? data.artifacts : [];
    const items: ArtifactListItem[] = rows.map((r) => {
      const sizeRaw = r.size_bytes ?? r.sizeBytes;
      return {
        artifactId: firstString(r.artifact_id, r.artifactId) ?? "",
        uri: firstString(r.uri) ?? "",
        type: firstString(r.type) ?? "",
        mimeType: firstString(r.mime_type, r.mimeType) ?? "application/octet-stream",
        ...(firstString(r.title) ? { title: firstString(r.title) } : {}),
        source: firstString(r.source) ?? "",
        ...(typeof sizeRaw === "number" && Number.isFinite(sizeRaw) ? { sizeBytes: sizeRaw } : {}),
        status: firstString(r.status) ?? "",
        createdAt: firstString(r.created_at, r.createdAt) ?? "",
      };
    });
    const nextCursor = firstString(data.next_cursor, data.nextCursor);
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }
}
