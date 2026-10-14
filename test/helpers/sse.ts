import { expect } from "bun:test";

/**
 * The one method this helper calls. `getReader()` is typed from Node's stream
 * types on a `Response` body and from the global ones on a `ReadableStream`,
 * and the two do not assign to each other; both satisfy this.
 */
interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/**
 * Read the `: connected` comment an SSE stream writes when it opens, so the
 * reader's next chunk is its first event.
 */
export async function readConnected(reader: ChunkReader): Promise<void> {
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toBe(": connected\n\n");
}
