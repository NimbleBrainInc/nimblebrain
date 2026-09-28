import { expect } from "bun:test";

/**
 * Read the `: connected` comment an SSE stream writes when it opens, so the
 * reader's next chunk is its first event.
 */
export async function readConnected(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toBe(": connected\n\n");
}
