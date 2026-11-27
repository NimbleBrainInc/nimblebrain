import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { FilesHost } from "../files/host.ts";
import { isTextMime } from "../files/mime.ts";
import { FileTooLargeError, readFileBody } from "../files/serve.ts";
import type { FileRecord } from "../files/types.ts";
import { FILE_URI_SCHEME, fileIdToUri, uriToFileId } from "../files/uri.ts";
import { log } from "../observability/log.ts";
import { HOST_RESOURCES_MAX_READ_SIZE } from "./capability.ts";

/**
 * The specification's code for "resource not found" on `resources/read`:
 * `-32602` with `{ uri }` as the data. `ai.nimblebrain/resources/read`
 * answers with the same code, so a future upstream version of the method is
 * a rename, not an error-code rewrite. The SDK's 2025 codec also rewrites a
 * thrown `-32002` to `-32602` on the wire, so throwing the code that is sent
 * keeps the log line and the wire in agreement.
 */
const RESOURCE_NOT_FOUND = -32602;

/**
 * Impl-defined server-error code for "response too large." Sibling to
 * `-32004 Rate limited` in the JSON-RPC reserved range — both are
 * deliberate quota responses, not server faults. `-32603 InternalError`
 * would mis-signal "this read exceeded the cap" as "the platform is
 * broken." Connector SDKs match on the specific code to back off
 * intelligently (e.g. split a large read into ranges once range reads
 * ship in v2).
 */
const RESPONSE_TOO_LARGE = -32005;

/** Files per `list` page the resolver asks for while it follows the cursor. */
const LIST_PAGE_SIZE = 100;

/**
 * Per-request context for resolving a host resource. The workspace id comes
 * from the connector's session, never from the URI — the platform owns the
 * identity, the URI carries only the file id. The owner id is the user the
 * connector's in-flight tool call was made for, passed by the caller that
 * tied the request to that call; the resolver never looks identity up itself.
 * The connector id rides along for audit / rate-limit attribution.
 */
export interface HostResourceContext {
  workspaceId: string;
  connectorId: string;
  /** Owner id (`resolveRequestOwnerId`) of the user the tool call was made for. */
  ownerId: string;
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
 * The single chokepoint a connector's inbound `ai.nimblebrain/resources/*`
 * request goes through (today the files contract; future schemes like
 * `entities://` would land here as additional read/list paths). Files are
 * workspace-owned: every read/list resolves in the connector's request workspace
 * (`ctx.workspaceId`) under the calling user's partition (`ctx.ownerId`) — never against any
 * wsId the URI might encode (the URI is bare), and never across workspaces.
 */
export interface HostResourcesResolver {
  /** The URI schemes this resolver serves now: advertised in the capability. */
  schemes(): string[];
  read(uri: string, ctx: HostResourceContext): Promise<ReadResourceResult>;
  list(params: ListResourcesParams, ctx: HostResourceContext): Promise<ListResourcesResult>;
}

/**
 * Resolves `files://<id>` URIs through the files contract: `resolve` as `host`
 * with the connector's workspace (`ctx.workspaceId`) and the user its tool call
 * was made for (`ctx.ownerId`), then the body streamed from its download URL;
 * a listing is the plugin's `list`, every page of it. Text types return as
 * `text`, everything else as base64 `blob`, the split `resources/read` uses.
 *
 * With no files plugin bound the resolver serves no scheme: the capability
 * advertises none, and every request is refused as an unsupported scheme.
 */
export class FilesHostResourcesResolver implements HostResourcesResolver {
  constructor(
    private readonly filesHost: () => FilesHost | null,
    private readonly maxReadSize: number = HOST_RESOURCES_MAX_READ_SIZE,
  ) {}

  schemes(): string[] {
    return this.filesHost() ? [FILE_URI_SCHEME] : [];
  }

  async read(uri: string, ctx: HostResourceContext): Promise<ReadResourceResult> {
    const start = Date.now();
    const host = this.requireFiles(uri);
    this.requireFileScheme(uri);
    const scope = { workspaceId: ctx.workspaceId, ownerId: ctx.ownerId };

    let result: Awaited<ReturnType<typeof readFileBody>>;
    try {
      result = await readFileBody(host, scope, uri, this.maxReadSize);
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        throw new ProtocolError(RESPONSE_TOO_LARGE, "Response too large", {
          uri,
          size: err.size,
          maxSize: err.maxSize,
        });
      }
      // A failed resolve or transfer collapses to not-found, as a file of
      // another owner does; the cause goes to the operator's log only.
      log.warn(
        `[host-resources] [${ctx.connectorId}:${ctx.workspaceId}] read failed (collapsing to resource-not-found): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ProtocolError(RESOURCE_NOT_FOUND, "Resource not found", { uri });
    }
    if (!result) throw new ProtocolError(RESOURCE_NOT_FOUND, "Resource not found", { uri });

    const { file, bytes } = result;
    const contents = isTextMime(file.mimeType)
      ? [{ uri, mimeType: file.mimeType, text: new TextDecoder().decode(bytes) }]
      : [{ uri, mimeType: file.mimeType, blob: Buffer.from(bytes).toString("base64") }];

    log.debug(
      "host-resources",
      `[${ctx.connectorId}:${ctx.workspaceId}] read ${uri} → ${file.size}B (${Date.now() - start}ms)`,
    );

    return { contents };
  }

  async list(params: ListResourcesParams, ctx: HostResourceContext): Promise<ListResourcesResult> {
    // The calling user's files in the connector's workspace only.
    const host = this.filesHost();
    if (!host || (params.filter?.scheme && params.filter.scheme !== FILE_URI_SCHEME)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unsupported URI scheme", {
        scheme: params.filter?.scheme ?? FILE_URI_SCHEME,
        supported: this.schemes(),
      });
    }
    // Pagination isn't offered: a listing is the whole set in one answer, so a
    // cursor would be silently ignored. Refuse it so a connector can tell.
    if (params.cursor && params.cursor.length > 0) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        "Pagination is not supported in this version",
        { cursor: params.cursor },
      );
    }
    // A `tags` that is not an array is refused rather than read as no filter,
    // which would lie about whether the filter ran.
    if (params.filter?.tags !== undefined && !Array.isArray(params.filter.tags)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        "filter.tags must be an array of strings",
        { receivedType: typeof params.filter.tags },
      );
    }
    const scope = { workspaceId: ctx.workspaceId, ownerId: ctx.ownerId };
    const all: FileRecord[] = [];
    let cursor: string | null = null;
    do {
      const page = await host.list(scope, {
        limit: LIST_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...(page.files ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);

    const mime = params.filter?.mimeType;
    const tagFilter = params.filter?.tags ?? [];
    const resources = all
      .filter((entry) => (mime ? entry.mimeType === mime : true))
      .filter((entry) => tagFilter.every((tag) => entry.tags?.includes(tag)))
      .map((entry) => ({
        uri: fileIdToUri(entry.id),
        name: entry.filename,
        mimeType: entry.mimeType,
      }));

    log.debug(
      "host-resources",
      `[${ctx.connectorId}:${ctx.workspaceId}] list → ${resources.length} resources`,
    );

    return { resources };
  }

  /** The files client, or the unsupported-scheme refusal when no plugin is bound. */
  private requireFiles(uri: string): FilesHost {
    const host = this.filesHost();
    if (host) return host;
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unsupported URI scheme", {
      uri,
      supported: [],
    });
  }

  /**
   * Single place that validates the URI scheme. Unknown schemes return
   * `-32602 Invalid params` with the supported set in `data.supported`,
   * so a connector author with a typo gets actionable feedback. The
   * resolver advertises only `files`; other schemes (e.g. `entities`) get added
   * here as the resolver gains additional backends.
   */
  private requireFileScheme(uri: string): string {
    const id = uriToFileId(uri);
    if (id) return id;
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unsupported URI scheme", {
      uri,
      supported: this.schemes(),
    });
  }
}
