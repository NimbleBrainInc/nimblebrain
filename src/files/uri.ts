/**
 * URI scheme for identity-owned files.
 *
 * Files persisted via the `FileStore` (`src/files/store.ts`) are addressable
 * as MCP resources at `files://<id>`. This is the canonical shape used in MCP
 * `resource_link` content blocks the platform persists in conversation user
 * messages — the blob lives in the file store, the conversation log only
 * carries the URI.
 *
 * Files are identity-owned (Phase B): every `FileStore` is built against the
 * owner's directory (`users/{userId}/files/`), so a `files://fl_…` URI
 * resolves against the caller's identity store regardless of which workspace
 * created the file. The URI itself does not encode the owner — file ids are
 * globally unique, so the owner's store resolves any of their files.
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
