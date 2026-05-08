/**
 * URI scheme for workspace files.
 *
 * Files persisted via the workspace `FileStore` (`src/files/store.ts`) are
 * addressable as MCP resources at `files://<id>`. This is the canonical
 * shape used in MCP `resource_link` content blocks the platform persists
 * in conversation user messages — the blob lives in the file store, the
 * conversation log only carries the URI.
 *
 * Workspace isolation is preserved by construction: every `FileStore` is
 * built against a workspace-scoped directory, so a `files://fl_…` URI
 * resolves only against the active workspace's store. The URI itself
 * does not encode the workspace.
 */

export const FILE_URI_SCHEME = "files";
const FILE_URI_PREFIX = `${FILE_URI_SCHEME}://`;

export function fileIdToUri(id: string): string {
  return `${FILE_URI_PREFIX}${id}`;
}

/** Returns the file id for a `files://` URI, or `null` for any other scheme. */
export function uriToFileId(uri: string): string | null {
  if (!uri.startsWith(FILE_URI_PREFIX)) return null;
  return uri.slice(FILE_URI_PREFIX.length);
}
