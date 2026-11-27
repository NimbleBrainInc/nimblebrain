/**
 * The URI of a file the files contract keeps: `files://<id>`, bare
 * (`contracts/files/CONTRACT.md` §4). The workspace is not in the URI; it comes
 * from the request that reads it, and the owner from the identity in it, so the
 * same URI resolves for its owner in its workspace and nowhere else.
 */

export const FILE_URI_SCHEME = "files";
const FILE_URI_PREFIX = `${FILE_URI_SCHEME}://`;

/**
 * A file id as the contract states it: minted by the implementation, at most 64
 * characters. The one validator for "is this a servable file id".
 */
export const FILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function fileIdToUri(id: string): string {
  return `${FILE_URI_PREFIX}${id}`;
}

/** The file id a `files://` URI names, or `null` for any other URI or a malformed id. */
export function uriToFileId(uri: string): string | null {
  if (!uri.startsWith(FILE_URI_PREFIX)) return null;
  const id = uri.slice(FILE_URI_PREFIX.length);
  return FILE_ID_RE.test(id) ? id : null;
}
