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
 * request goes through. Wraps the workspace's `FileStore` (today; future
 * schemes like `entities://` would land here as additional read/list
 * paths). Workspace isolation is preserved by construction: every read
 * resolves against the FileStore corresponding to the session's
 * workspace id, never against any wsId the URI might encode.
 */
export interface HostResourcesResolver {
  read(uri: string, ctx: HostResourceContext): Promise<ReadResourceResult>;
  list(params: ListResourcesParams, ctx: HostResourceContext): Promise<ListResourcesResult>;
}

/**
 * Resolves `files://<id>` URIs through a workspace-scoped `FileStore`.
 * Reuses `isTextMime`/`fileIdToUri` from the platform's `files` source
 * so the byte/text discrimination matches what the agent sees via
 * `files__read` exactly. Audit events ride the platform's existing
 * event sink alongside other tool activity.
 */
export class FileBackedHostResourcesResolver implements HostResourcesResolver {
  constructor(
    private readonly getFileStoreForWorkspace: (workspaceId: string) => FileStore,
    private readonly maxReadSize: number = HOST_RESOURCES_MAX_READ_SIZE,
  ) {}

  async read(uri: string, ctx: HostResourceContext): Promise<ReadResourceResult> {
    const start = Date.now();
    const fileId = this.requireFileScheme(uri);
    const store = this.getFileStoreForWorkspace(ctx.workspaceId);

    let result: Awaited<ReturnType<typeof store.readFile>>;
    try {
      result = await store.readFile(fileId);
    } catch {
      // Two failure modes collapse into one error code here on purpose:
      // file genuinely doesn't exist in this workspace, vs file is in a
      // different workspace (we never look across workspaces). The same
      // response prevents inventory enumeration across tenants.
      throw new McpError(RESOURCE_NOT_FOUND, "Resource not found", { uri });
    }

    if (result.size > this.maxReadSize) {
      throw new McpError(ErrorCode.InternalError, "Response too large", {
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
    // Pagination isn't supported in v1 — listing a workspace's files
    // returns the full set in a single call. A bundle that passes a
    // cursor would otherwise silently get the full set every call,
    // breaking polite pagination loops. Reject loudly so the bundle
    // SDK can detect the missing feature.
    if (params.cursor && params.cursor.length > 0) {
      throw new McpError(ErrorCode.InvalidParams, "Pagination is not supported in this version", {
        cursor: params.cursor,
      });
    }

    const store = this.getFileStoreForWorkspace(ctx.workspaceId);
    const all = await store.readRegistry();

    const filteredByMime = params.filter?.mimeType
      ? all.filter((entry) => entry.mimeType === params.filter?.mimeType)
      : all;

    const filteredByTags = params.filter?.tags?.length
      ? filteredByMime.filter((entry) =>
          (params.filter?.tags ?? []).every((tag) => entry.tags?.includes(tag)),
        )
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
