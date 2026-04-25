/**
 * Base64-encode a Uint8Array. Prefers Bun/Node's native `Buffer` (a single
 * C++ call, significantly faster on large binaries than the chunked `btoa`
 * loop) and falls back to a stack-safe `btoa` loop for runtimes without
 * `Buffer`.
 *
 * Used by both the `/v1/resources/read` API path and the in-process MCP
 * server resource read path. Lives in `util/` so neither layer depends on
 * the other to share encoding details.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
