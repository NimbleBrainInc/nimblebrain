import type { ChatStartResponse } from "../../src/api/schemas/responses.ts";
import { readJson } from "./http.ts";

/** How long a turn may take before the helper gives up on its terminal frame. */
const TURN_TIMEOUT_MS = 15_000;

/**
 * Run one chat turn over HTTP the way a client does: `POST …/chat/start`, then
 * read `GET /v1/conversations/:id/events` until the turn's terminal frame.
 *
 * A refused start (any non-2xx) comes back as that response. Otherwise the
 * answer is a `Response` built from the terminal frame: `done` as 200 with its
 * `ChatResponse` body, `error` as 500 with `{ error, message }`, `cancelled` as
 * 499 with `{}`. `init` is the start request's; its headers (auth, cookies) are
 * reused for the event stream.
 */
export async function postChatTurn(
  baseUrl: string,
  wsId: string,
  init: RequestInit,
): Promise<Response> {
  const start = await fetch(`${baseUrl}/v1/workspaces/${wsId}/chat/start`, {
    method: "POST",
    ...init,
  });
  if (!start.ok) return start;
  const { conversationId } = await readJson<ChatStartResponse>(start);

  const headers = new Headers(init.headers);
  headers.delete("Content-Type");
  const events = await fetch(`${baseUrl}/v1/conversations/${conversationId}/events`, { headers });
  if (!events.ok || !events.body) return events;

  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let buffer = "";
  let eventType = "";
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const status = TERMINAL_STATUS[eventType];
          if (status !== undefined) {
            return new Response(line.slice(6), {
              status,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`turn in ${conversationId} sent no terminal frame`);
}

/** The status each terminal frame of a turn is answered with. */
const TERMINAL_STATUS: Record<string, number> = { done: 200, error: 500, cancelled: 499 };
