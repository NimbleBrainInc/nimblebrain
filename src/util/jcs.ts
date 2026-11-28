/**
 * JSON Canonicalization Scheme (RFC 8785): the one byte form of a JSON value,
 * so a digest over it is the same whoever serialized the value.
 *
 * - Object members are sorted by their names' UTF-16 code units, recursively.
 * - Strings and numbers are serialized as ECMAScript's `JSON.stringify` does,
 *   which is what the RFC defines them as.
 * - Arrays keep their order; no whitespace anywhere.
 *
 * A value JSON cannot hold (a non-finite number, `undefined`, a function, a
 * bigint) throws, since it has no canonical form.
 */

/** The canonical JSON text of `value`. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error(`JCS: ${value} has no JSON form`);
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const record = value as Record<string, unknown>;
      // Default `sort` compares UTF-16 code units, which is the RFC's order.
      const keys = Object.keys(record).sort();
      const members: string[] = [];
      for (const key of keys) {
        if (record[key] === undefined) continue;
        members.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      }
      return `{${members.join(",")}}`;
    }
    default:
      throw new Error(`JCS: a ${typeof value} has no JSON form`);
  }
}

/** The canonical UTF-8 bytes of `value`. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
