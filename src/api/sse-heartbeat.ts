const encoder = new TextEncoder();

/**
 * The comment a long-lived SSE stream writes the moment it opens. A server
 * sends a streamed response's status and headers with its first chunk, so a
 * stream that waits for its first event leaves the client's request pending
 * until something happens to be broadcast (up to a full heartbeat). The
 * parser ignores comment lines, so this reaches no event handler.
 */
export const CONNECTED_FRAME = encoder.encode(": connected\n\n");
