/**
 * Reading pinned bytes from a plugin catalog (ADR-0068): a bounded fetch, and
 * the sha256 check every catalog read applies before it trusts what came back.
 * The connector skill resolver and the connector list read the catalog through
 * these, so both apply one rule: bytes are used only when their digest is the pin.
 */

import { createHash } from "node:crypto";

export interface BoundedFetchOptions {
  /** Injectable fetch; tests pass a fixture. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). */
  timeoutMs: number;
  /** The most bytes read; a response past it is refused before its digest is checked. */
  maxBytes: number;
}

/** A catalog response that was not 2xx. `status` lets a caller treat a 404 as "not here". */
export class CatalogHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`plugin catalog fetch failed: HTTP ${status} (${url})`);
  }
}

/** Fetch `url` and return its body, refusing a non-2xx answer or one larger than `maxBytes`. */
export async function fetchBounded(url: string, opts: BoundedFetchOptions): Promise<Uint8Array> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new CatalogHttpError(res.status, url);
  }
  const tooLarge = () => new Error(`plugin catalog fetch exceeds ${opts.maxBytes} bytes (${url})`);
  const declared = Number(res.headers.get("content-length"));
  if (declared > opts.maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Throw unless `bytes` hash to `expected`, naming `what` and both digests. */
export function assertDigest(what: string, bytes: Uint8Array, expected: string): void {
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`${what} integrity mismatch: got ${actual}, expected ${expected}`);
  }
}
