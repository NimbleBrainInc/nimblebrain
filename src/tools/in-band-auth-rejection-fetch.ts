import type { FetchLike } from "@modelcontextprotocol/client";

/**
 * A transport fetch that turns a server's in-band access-token rejection into
 * the 401 the MCP authorization spec requires, so the SDK's own 401 path
 * answers it: refresh with the stored refresh token, retry the request once,
 * and throw if the fresh token is refused too (`McpSource` reads that as
 * `auth-lost`, then `reauth_required`).
 *
 * Some servers answer a refused token with HTTP 200 and an `isError` result
 * whose text says so. `isError` alone means only that a tool failed, so the
 * text is what marks it: `phrases` is the wording the connector's catalog entry
 * declares (`inBandAuthErrors`), compared case-insensitively.
 *
 * Only a `tools/call` answer is read. A rejected token means the server refused
 * the call before running it, so the SDK's retry does not repeat its work. A
 * task's later outcome (`tasks/get`) is never rewritten: it is stored, and
 * replaying it on a fresh token would read the same rejection and wrongly flip
 * the connection to `reauth_required`.
 *
 * For the same reason the rejection is the answer's first message, so only that
 * message is waited for. An SSE answer is handed on as soon as its first
 * message is not a rejection, and streams from there: a server's own request
 * on that stream (a host resource, elicitation) must reach the client while the
 * tool waits for the reply.
 */
export function createInBandAuthRejectionFetch(
  inner: FetchLike,
  phrases: readonly string[],
): FetchLike {
  const needles = phrases.map((phrase) => phrase.toLowerCase());
  return async (input, init) => {
    const response = await inner(input, init);
    const ids = toolCallIds(init?.body);
    if (ids.size === 0 || response.status !== 200 || !response.body) return response;
    if (mediaType(response) === "text/event-stream") {
      return answerSse(response, response.body, (message) => isRejection(message, ids, needles));
    }
    const body = await response.text();
    return isRejection(body, ids, needles) ? unauthorized() : rebuilt(response, body);
  };
}

/**
 * Read an SSE answer up to its first message: a 401 when that message is a
 * rejection, otherwise the answer as it came, the bytes already read first.
 */
async function answerSse(
  response: Response,
  stream: ReadableStream<Uint8Array>,
  rejects: (message: string) => boolean,
): Promise<Response> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const read: Uint8Array[] = [];
  let text = "";
  let first: string | undefined;
  let done = false;
  while (first === undefined && !done) {
    const chunk = await reader.read();
    if (chunk.done) {
      done = true;
      first = sseMessages(text + decoder.decode())[0];
    } else {
      read.push(chunk.value);
      text += decoder.decode(chunk.value, { stream: true });
      first = sseMessages(completeEvents(text))[0];
    }
  }
  if (first !== undefined && rejects(first)) {
    await reader.cancel().catch(() => {});
    return unauthorized();
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of read) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return rebuilt(response, body);
}

function unauthorized(): Response {
  return new Response(null, {
    status: 401,
    statusText: "Unauthorized",
    headers: { "www-authenticate": 'Bearer error="invalid_token"' },
  });
}

function rebuilt(response: Response, body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** The JSON-RPC ids of the `tools/call` requests in a POST body. */
function toolCallIds(body: unknown): Set<unknown> {
  if (typeof body !== "string") return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Set();
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  return new Set(
    requests
      .filter((r): r is { method: string; id: unknown } => r?.method === "tools/call")
      .map((r) => r.id),
  );
}

function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The events of an SSE body that a blank line has ended. */
function completeEvents(text: string): string {
  return text
    .split(/\r?\n\r?\n/)
    .slice(0, -1)
    .join("\n\n");
}

/** The `data` payload of each event in an SSE body; an event with none (a priming id, a comment) has no message. */
function sseMessages(body: string): string[] {
  return body.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    return data.length > 0 ? [data.join("\n")] : [];
  });
}

/** Whether a JSON-RPC message answers one of `ids` with a declared rejection. */
function isRejection(message: string, ids: Set<unknown>, needles: readonly string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return false;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).some((m) => {
    if (!ids.has(m?.id) || m?.result?.isError !== true) return false;
    const content: unknown = m.result.content;
    if (!Array.isArray(content)) return false;
    const text = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .toLowerCase();
    return needles.some((needle) => text.includes(needle));
  });
}
