import {
  ErrorCode,
  type ListResourcesResult,
  McpError,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "../cli/log.ts";
import { isTextMime } from "../files/mime.ts";
import type { FileStore } from "../files/store.ts";
import { FILE_URI_SCHEME, fileIdToUri, uriToFileId } from "../files/uri.ts";
import { HOST_RESOURCES_MAX_READ_SIZE } from "./capability.ts";

/**
 * MCP convention for "resource not found" responses to `resources/read`
 * requests. Not in the SDK's JSON-RPC ErrorCode enum (which only carries
 * the standard JSON-RPC numbers), but used by `resources/read` in the
 * spec. We deliberately surface the same code from
 * `ai.nimblebrain/resources/read` so a future upstream migration
 * (Layer 3) is a method-name rename, not an error-code rewrite.
 */
const RESOURCE_NOT_FOUND = -32002;

/**
 * Impl-defined server-error code for "response too large." Sibling to
 * `-32004 Rate limited` in the JSON-RPC reserved range — both are
 * deliberate quota responses, not server faults. `-32603 InternalError`
 * would mis-signal "this read exceeded the cap" as "the platform is
 * broken." Bundle SDKs match on the specific code to back off
 * intelligently (e.g. split a large read into ranges once range reads
 * ship in v2).
 */
const RESPONSE_TOO_LARGE = -32005;

/**
 * Per-call context for resolving a host resource. The workspace id comes
 * from the bundle's session, never from the URI — the platform owns the
 * identity, the URI carries only the file id. The bundle id rides along
 * for audit / rate-limit attribution.
 */
export interface HostResourceContext {
  workspaceId: string;
  bundleId: string;
}

export interface ListResourcesParams {
  cursor?: string;
  filter?: {
    scheme?: string;
    mimeType?: string;
    tags?: string[];
  };
}

/**
 * The single chokepoint a bundle's inbound `ai.nimblebrain/resources/*`
 * request goes through. Wraps the session user's identity `FileStore` (today;
 * future schemes like `entities://` would land here as additional read/list
 * paths). Files are identity-owned (Phase B): every read/list resolves against
 * the FileStore of the user whose session the bundle is running in — never
 * against any wsId the URI might encode, and never a workspace silo.
 */
export interface HostResourcesResolver {
  read(uri: string, ctx: HostResourceContext): Promise<ReadResourceResult>;
  list(params: ListResourcesParams, ctx: HostResourceContext): Promise<ListResourcesResult>;
}

/**
 * Resolves `files://<id>` URIs through the session user's identity `FileStore`.
 * Reuses `isTextMime`/`fileIdToUri` from the platform's `files` source
 * so the byte/text discrimination matches what the agent sees via
 * `files__read` exactly. Audit events ride the platform's existing
 * event sink alongside other tool activity.
 *
 * `getFileStore` resolves the caller's identity store; it takes no workspace
 * because files are identity-owned. `ctx.workspaceId` survives on read/list
 * for audit logging (which workspace the bundle ran in), not for storage.
 */
export class FileBackedHostResourcesResolver implements HostResourcesResolver {
  constructor(
    private readonly getFileStore: () => FileStore,
    private readonly maxReadSize: number = HOST_RESOURCES_MAX_READ_SIZE,
  ) {}

  async read(uri: string, ctx: HostResourceContext): Promise<ReadResourceResult> {
    const start = Date.now();
    const fileId = this.requireFileScheme(uri);
    const store = this.getFileStore();

    let result: Awaited<ReturnType<typeof store.readFile>>;
    try {
      result = await store.readFile(fileId);
    } catch (err) {
      // Multiple failure modes collapse into one error code here on
      // purpose: file genuinely doesn't exist in the user's store, file
      // belongs to a different user (we never look across identities),
      // disk I/O / permission / corruption errors. The collapse
      // prevents cross-identity inventory enumeration AND keeps the wire
      // contract simple for bundle SDKs. But operators chasing a real
      // disk-side issue need visibility — log the actual error before
      // collapsing so the ops trail isn't blind.
      log.warn(
        `[host-resources] [${ctx.bundleId}:${ctx.workspaceId}] read ${uri} failed (collapsing to -32002): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new McpError(RESOURCE_NOT_FOUND, "Resource not found", { uri });
    }

    if (result.size > this.maxReadSize) {
      throw new McpError(RESPONSE_TOO_LARGE, "Response too large", {
        uri,
        size: result.size,
        maxSize: this.maxReadSize,
      });
    }

    const contents = isTextMime(result.mimeType)
      ? [
          {
            uri,
            mimeType: result.mimeType,
            text: result.data.toString("utf-8"),
          },
        ]
      : [
          {
            uri,
            mimeType: result.mimeType,
            blob: result.data.toString("base64"),
          },
        ];

    log.debug(
      "host-resources",
      `[${ctx.bundleId}:${ctx.workspaceId}] read ${uri} → ${result.size}B (${Date.now() - start}ms)`,
    );

    return { contents };
  }

  async list(params: ListResourcesParams, ctx: HostResourceContext): Promise<ListResourcesResult> {
    if (params.filter?.scheme && params.filter.scheme !== FILE_URI_SCHEME) {
      throw new McpError(ErrorCode.InvalidParams, "Unsupported URI scheme", {
        scheme: params.filter.scheme,
        supported: [FILE_URI_SCHEME],
      });
    }
    // Pagination isn't supported in v1 — listing the user's files
    // returns the full set in a single call. A bundle that passes a
    // cursor would otherwise silently get the full set every call,
    // breaking polite pagination loops. Reject loudly so the bundle
    // SDK can detect the missing feature.
    if (params.cursor && params.cursor.length > 0) {
      throw new McpError(ErrorCode.InvalidParams, "Pagination is not supported in this version", {
        cursor: params.cursor,
      });
    }

    const store = this.getFileStore();
    const all = await store.readRegistry();

    const filteredByMime = params.filter?.mimeType
      ? all.filter((entry) => entry.mimeType === params.filter?.mimeType)
      : all;

    // Validate `tags` shape before iterating. A buggy bundle that sends
    // `tags: "single-tag"` (string) instead of `tags: ["single-tag"]`
    // would otherwise throw TypeError on `.every` and surface as a
    // generic dispatch failure with no diagnostic. Reject with
    // `-32602 Invalid params`, mirroring the unsupported-scheme branch
    // above: same error code, same actionable shape for the bundle
    // author. Treating non-array as "no filter" was considered and
    // rejected — silently returning all files lies about whether the
    // filter ran.
    if (params.filter?.tags !== undefined && !Array.isArray(params.filter.tags)) {
      throw new McpError(ErrorCode.InvalidParams, "filter.tags must be an array of strings", {
        receivedType: typeof params.filter.tags,
      });
    }
    const tagFilter = params.filter?.tags ?? [];
    const filteredByTags =
      tagFilter.length > 0
        ? filteredByMime.filter((entry) => tagFilter.every((tag) => entry.tags?.includes(tag)))
        : filteredByMime;

    const resources = filteredByTags.map((entry) => ({
      uri: fileIdToUri(entry.id),
      name: entry.filename,
      mimeType: entry.mimeType,
    }));

    log.debug(
      "host-resources",
      `[${ctx.bundleId}:${ctx.workspaceId}] list → ${resources.length} resources`,
    );

    return { resources };
  }

  /**
   * Single place that validates the URI scheme. Unknown schemes return
   * `-32602 Invalid params` with the supported set in `data.supported`,
   * so a bundle author with a typo gets actionable feedback. Phase 1
   * advertises only `files`; future schemes (e.g. `entities`) get added
   * here as the resolver gains additional backends.
   */
  private requireFileScheme(uri: string): string {
    const id = uriToFileId(uri);
    if (id) return id;
    throw new McpError(ErrorCode.InvalidParams, "Unsupported URI scheme", {
      uri,
      supported: [FILE_URI_SCHEME],
    });
  }
}
