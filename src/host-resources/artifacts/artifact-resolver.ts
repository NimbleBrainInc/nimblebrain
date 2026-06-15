import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../../cli/log.ts";
import { isTextMime } from "../../files/mime.ts";
import { isArtifactUri, uriToArtifactId } from "./artifact-uri.ts";
import {
  ArtifactNotFoundError,
  type ArtifactReadClient,
  type ArtifactReadResult,
} from "./data-plane-read-client.ts";

/**
 * Generic host resolver for `artifact://` references.
 *
 * This is the read-side of a foundational primitive — the sibling of the
 * `files://` upload resolver — not capability code. It resolves *any*
 * `artifact://<id>` for *any* producing capability: it knows nothing about what
 * the artifact is, only how to fetch its bytes from the data plane as the
 * viewing user and shape them into the standard MCP `ReadResourceResult` the
 * rest of the host already consumes.
 *
 * Trust: the resolver carries the viewing user's verified workspace into the
 * read client, which mints a workspace-scoped read token; RLS in the data plane
 * is the enforcement point. No producing bundle is ever in this read path —
 * resolution is decoupled from the bundle's `resources/read` and its liveness.
 *
 * The bytes this returns are UNTRUSTED (a report can quote a hostile page). The
 * resolver does not render — it returns raw bytes/text. Sanitization happens at
 * the render boundary in the web client, keyed by `mime_type`.
 */

/**
 * Cap on how many bytes the host will pull through its own request path for an
 * inline artifact. Large bodies should arrive as a presigned URL (the data
 * plane brokers it after RLS authorizes); this cap bounds the proxy path so a
 * mis-sized inline body can't balloon a response. Sibling to the host-resources
 * read cap.
 */
export const ARTIFACT_MAX_PROXY_BYTES = 8 * 1024 * 1024;

export class ArtifactTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxSize: number,
  ) {
    super(`artifact body ${size}B exceeds the host proxy cap of ${maxSize}B`);
    this.name = "ArtifactTooLargeError";
  }
}

export class ArtifactResolver {
  constructor(
    private readonly client: ArtifactReadClient,
    private readonly maxProxyBytes: number = ARTIFACT_MAX_PROXY_BYTES,
    /** Injectable fetch for the presigned-URL leg; defaults to global. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** True iff this resolver handles the URI. Lets the caller fall through. */
  handles(uri: string): boolean {
    return isArtifactUri(uri);
  }

  /**
   * Resolve an `artifact://<id>` reference to MCP resource contents, reading as
   * the viewing user (whose verified workspace is `workspaceId`).
   *
   * Returns the standard `{ contents: [{ uri, mimeType, text|blob }] }` shape so
   * it drops into the existing resource-read envelope unchanged. A text MIME
   * yields `text`; anything else yields a base64 `blob`, matching how the
   * `files://` resolver discriminates.
   */
  async read(uri: string, workspaceId: string): Promise<ReadResourceResult> {
    const start = Date.now();
    const id = uriToArtifactId(uri);
    // `handles()` is the caller's gate; if they reach here with a non-artifact
    // URI it's a programming error, surface it plainly.
    if (id === null) {
      throw new Error(`ArtifactResolver.read called with non-artifact URI "${uri}"`);
    }

    const result = await this.client.read(id, workspaceId);
    const bytes = await this.materialize(id, result);

    if (bytes.byteLength > this.maxProxyBytes) {
      throw new ArtifactTooLargeError(bytes.byteLength, this.maxProxyBytes);
    }

    const contents = isTextMime(result.mimeType)
      ? [{ uri, mimeType: result.mimeType, text: new TextDecoder().decode(bytes) }]
      : [{ uri, mimeType: result.mimeType, blob: Buffer.from(bytes).toString("base64") }];

    log.debug(
      "host-resources",
      `[artifact] read ${uri} (ws=${workspaceId}) → ${bytes.byteLength}B ${result.mimeType} (${Date.now() - start}ms)`,
    );

    return { contents };
  }

  /**
   * Turn a read result into concrete bytes. Inline bodies are already bytes; a
   * presigned URL is fetched unauthenticated (the URL carries its own grant) so
   * large bodies travel store→host directly, not back through the data-plane
   * read API.
   */
  private async materialize(id: string, result: ArtifactReadResult): Promise<Uint8Array> {
    if (result.body) return result.body;
    if (result.presignedUrl) {
      let res: Response;
      try {
        res = await this.fetchImpl(result.presignedUrl);
      } catch (cause) {
        throw new ArtifactNotFoundError(id);
      }
      if (!res.ok) {
        // A dead/expired presigned URL is indistinguishable to the user from a
        // missing artifact; collapse to not-found rather than leaking storage
        // internals.
        throw new ArtifactNotFoundError(id);
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    // The read client guarantees one of the two is present; defensive.
    throw new ArtifactNotFoundError(id);
  }
}
