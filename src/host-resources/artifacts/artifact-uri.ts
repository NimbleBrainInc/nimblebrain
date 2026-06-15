/**
 * URI scheme for capability-produced artifacts.
 *
 * A capability (an MCP server) that produces large, durable, rendered output
 * writes it to the shared data plane and returns a reference as an MCP
 * `resource_link` content block at `artifact://<id>`. The body never travels
 * in the tool result; the host resolves the reference against the data plane
 * with the viewing user's identity and renders it.
 *
 * `artifact://` is deliberately distinct from `files://` (identity-owned
 * uploads). The two are different *kinds* with different trust: an upload is
 * user-provided and trusted-ish; an artifact is workspace-owned, generated,
 * and may carry attacker-influenced bytes (a report can quote a hostile web
 * page). The scheme carries that trust signal so the safe default — resolve
 * with the user's identity, then sanitize before rendering — is legible at the
 * address, not buried in a metadata field.
 *
 * The URI does not encode tenant or workspace. Identity is not data: the
 * viewing user's verified `(tenant, workspace)` comes from the request, and
 * row-level security in the data plane is the access-control gate. A guessed
 * `<id>` is worthless without first passing that gate.
 */

export const ARTIFACT_URI_SCHEME = "artifact";
const ARTIFACT_URI_PREFIX = `${ARTIFACT_URI_SCHEME}://`;

/**
 * Artifact ids are opaque, bounded, injection-safe tokens. The host never
 * parses meaning out of an id — it forwards it verbatim to the data plane —
 * but it rejects shapes that could smuggle a path, a query, or control
 * characters into the read request. Mirrors the bounded safe-id grammar the
 * data plane accepts; a stricter local gate fails a malformed reference here
 * with a clear cause rather than as an opaque downstream rejection.
 */
const ARTIFACT_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Thrown for an `artifact://` URI whose id fails the safe-id grammar (empty,
 * over-long, or carrying chars that could smuggle a path/query/control byte).
 * This is a *client-input* error — a malformed reference supplied by the caller
 * — so the API layer maps it to a 400, not a 502. Distinct from a downstream
 * read failure (those are the data-plane read client's errors).
 */
export class InvalidArtifactUriError extends Error {
  constructor(
    readonly uri: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidArtifactUriError";
  }
}

export function artifactIdToUri(id: string): string {
  return `${ARTIFACT_URI_PREFIX}${id}`;
}

/** True for any `artifact://` URI, regardless of whether the id is well-formed. */
export function isArtifactUri(uri: string): boolean {
  return typeof uri === "string" && uri.startsWith(ARTIFACT_URI_PREFIX);
}

/**
 * Extract the artifact id from an `artifact://<id>` URI.
 *
 * Returns `null` for any other scheme (so a caller can fall through to the
 * next resolver) and throws for the `artifact://` scheme with a malformed id
 * (so a typo'd reference fails loudly rather than reaching the data plane).
 */
export function uriToArtifactId(uri: string): string | null {
  if (!isArtifactUri(uri)) return null;
  const id = uri.slice(ARTIFACT_URI_PREFIX.length);
  if (!ARTIFACT_ID_RE.test(id)) {
    throw new InvalidArtifactUriError(
      uri,
      `invalid artifact id in URI "${uri}": id must match ${ARTIFACT_ID_RE} (1..128 chars, [A-Za-z0-9_.-])`,
    );
  }
  return id;
}
