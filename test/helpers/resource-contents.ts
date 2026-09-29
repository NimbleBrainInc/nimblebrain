/**
 * Read one field off a resource contents entry.
 *
 * An entry carries `text` or `blob`, never both, and its type is that union, so
 * a direct read of either field does not typecheck. Each returns the field when
 * the entry carries it and `undefined` when it carries the other, which is what
 * an assertion like "text comes back as text, not blob" means.
 */
export function textOf(entry: object | undefined): string | undefined {
  return entry && "text" in entry && typeof entry.text === "string" ? entry.text : undefined;
}

export function blobOf(entry: object | undefined): string | undefined {
  return entry && "blob" in entry && typeof entry.blob === "string" ? entry.blob : undefined;
}
