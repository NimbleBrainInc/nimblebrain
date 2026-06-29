/**
 * URI scheme for workspace-owned files.
 *
 * Files persisted via the `FileStore` (`src/files/store.ts`) are addressable
 * as MCP resources at `files://<id>`. This is the canonical shape used in MCP
 * `resource_link` content blocks the platform persists in conversation user
 * messages — the blob lives in the file store, the conversation log only
 * carries the URI.
 *
 * Files are workspace-owned: a `FileStore` is built against one owner's partition in
 * one workspace (`workspaces/<wsId>/files/<ownerId>/`). The `files://fl_…` URI stays
 * bare — it does NOT encode the workspace or owner; the workspace comes from the ambient
 * request (`RequestContext.fileWorkspaceId`), and the owner from the request
 * identity. File ids are globally unique, so the URI resolves once the workspace is
 * known.
 */

export const FILE_URI_SCHEME = "files";
const FILE_URI_PREFIX = `${FILE_URI_SCHEME}://`;

/**
 * Canonical stored-file id shape — the ONE validator for "is this a servable
 * file id." Two accepted schemes:
 *   - `fl_<24 hex>`            — current (`generateFileId` in `store.ts`).
 *   - `fl_<base36>_<8 hex>`    — legacy; historical `files://` links still
 *                                resolve, so anything that gates file ids
 *                                (the serve handler AND the migration) MUST
 *                                accept it or those files become unreachable.
 * Import this everywhere a file id is validated — never re-declare a stricter
 * copy, or "what the runtime serves" and "what the migration moves" drift.
 */
export const FILE_ID_RE = /^fl_(?:[a-f0-9]{24}|[a-z0-9]+_[a-f0-9]{8})$/;

export function fileIdToUri(id: string): string {
  return `${FILE_URI_PREFIX}${id}`;
}

/** Returns the file id for a `files://` URI, or `null` for any other scheme. */
export function uriToFileId(uri: string): string | null {
  if (!uri.startsWith(FILE_URI_PREFIX)) return null;
  return uri.slice(FILE_URI_PREFIX.length);
}
