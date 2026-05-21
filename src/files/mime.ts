/**
 * Text/blob mime classification shared between the agent-side
 * `files__read` tool and the bundle-side host-resources resolver.
 *
 * Single source of truth — if one path supports a new text-extractable
 * mime (e.g. `application/jsonl`), both pick it up automatically. Prior
 * to this extraction, the two paths duplicated the predicate verbatim
 * with a "keep in sync" comment, which is the failure mode this module
 * exists to prevent.
 */

const TEXT_MIMES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "text/yaml",
  "application/json",
  "application/xml",
  "application/yaml",
]);

/**
 * Returns true when the mime should be delivered as `text` in MCP
 * resource contents; false to deliver as `blob` (base64).
 *
 * Conservative bias: `text/*` always returns true, plus an allowlist
 * of structured text formats under `application/*` whose bytes are
 * valid UTF-8 by spec.
 */
export function isTextMime(mimeType: string): boolean {
  const bare = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return bare.startsWith("text/") || TEXT_MIMES.has(bare);
}
