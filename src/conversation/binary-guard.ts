/**
 * Refuse to persist binary payloads into the conversation log.
 *
 * Buffer / Uint8Array / any other ArrayBuffer view serialises through
 * `JSON.stringify` as `{"0":N,"1":N,"2":N,...}` — one key per byte,
 * ~10× the size of the raw bytes. A single 100 KB image bloats its
 * conversation file by ~1 MB. The architectural fix is to persist a
 * `resource_link` to the workspace `FileStore` and rehydrate at the
 * model boundary; this guard is the defensive backstop that ensures
 * the bug can't silently come back. See issue #54.
 *
 * Throws synchronously with a path-qualified message so the offending
 * field is easy to locate. Cycles are guarded with a `WeakSet` so
 * pathological self-referential events don't loop.
 */
export function assertNoBinaryPayloads(value: unknown, context: string): void {
  visit(value, context, new WeakSet());
}

function visit(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object") return;
  const obj = value as object;
  if (seen.has(obj)) return;
  seen.add(obj);

  // ArrayBuffer.isView covers Buffer, Uint8Array, Int8Array, Uint16Array,
  // and every other typed-array view in one check.
  if (ArrayBuffer.isView(value)) {
    throw new Error(
      `Refusing to persist binary payload at ${path} (${(value as { constructor: { name: string } }).constructor.name}). ` +
        `Store bytes in the workspace FileStore and reference them via a resource_link — see issue #54.`,
    );
  }
  if (value instanceof ArrayBuffer) {
    throw new Error(
      `Refusing to persist ArrayBuffer at ${path}. ` +
        `Store bytes in the workspace FileStore and reference them via a resource_link — see issue #54.`,
    );
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      visit(value[i], `${path}[${i}]`, seen);
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    visit((obj as Record<string, unknown>)[key], `${path}.${key}`, seen);
  }
}
