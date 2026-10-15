/**
 * Tool-call index repair for OpenAI-compatible Chat Completions streams.
 *
 * Some gateways stream a tool call's closing `arguments` fragment on the next
 * `index` (N+1) instead of the call's own (N), with no `id` and no
 * `function.name`. Nebius does this intermittently for `openai/gpt-oss-120b`
 * (measured: the last fragment of a call opened on index 0 arrives on index 1,
 * in the chunk that carries `finish_reason`). The AI SDK's streaming
 * tool-call tracker reads an unseen index as a new call and throws
 * `Expected 'id' to be a string.`, so the run fails on that model call.
 *
 * The OpenAI streaming contract opens every tool call with its `id` and
 * `function.name`. So a delta that carries neither, on an index this response
 * has not opened, can only continue the call before it: this rewrites its index
 * to that call's. A genuine new call carries an id and a name and is never
 * touched, so parallel calls stay separate. Every other byte passes through
 * unchanged.
 *
 * The repair runs below the SDK's parser, as a `fetch` wrapper, because the
 * tracker throws inside the provider's own stream transform, before any
 * language-model middleware sees a part. A repaired response logs one
 * `[model] repaired tool-call index` line, so the repair's use is visible and it
 * can be removed once the gateway streams well-formed calls.
 */

import { log } from "../observability/log.ts";

/** The `fetch` call signature the AI SDK providers invoke. */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ToolCallDelta {
  index?: number | null;
  id?: string | null;
  function?: { name?: string | null } | null;
}

interface StreamChunk {
  choices?: Array<{ index?: number; delta?: { tool_calls?: ToolCallDelta[] | null } | null }>;
}

/** Tool-call indices one choice has opened, and the latest call's index. */
interface ChoiceCalls {
  opened: Set<number>;
  latest: number | undefined;
}

/** A delta that opens a call carries its id or its function name. */
function opensCall(delta: ToolCallDelta): boolean {
  return (delta.id != null && delta.id !== "") || delta.function?.name != null;
}

/** Repair one choice's deltas in place. Returns true when an index was rewritten. */
function repairChoiceDeltas(deltas: ToolCallDelta[], calls: ChoiceCalls): boolean {
  let repaired = false;
  for (const delta of deltas) {
    const index = delta.index;
    if (typeof index !== "number") continue;
    if (!opensCall(delta) && !calls.opened.has(index) && calls.latest !== undefined) {
      delta.index = calls.latest;
      repaired = true;
      continue;
    }
    calls.opened.add(index);
    calls.latest = index;
  }
  return repaired;
}

/**
 * Repair one parsed chunk in place. Returns true when an index was rewritten.
 * `state` holds each choice's opened indices across the whole response.
 */
export function repairToolCallIndices(
  chunk: StreamChunk,
  state: Map<number, ChoiceCalls>,
): boolean {
  let repaired = false;
  for (const choice of chunk.choices ?? []) {
    const deltas = choice.delta?.tool_calls;
    if (!Array.isArray(deltas)) continue;
    const key = choice.index ?? 0;
    let calls = state.get(key);
    if (!calls) {
      calls = { opened: new Set(), latest: undefined };
      state.set(key, calls);
    }
    if (repairChoiceDeltas(deltas, calls)) repaired = true;
  }
  return repaired;
}

/**
 * Repair one SSE line. Lines that are not `data:` JSON chunks, and chunks that
 * need no repair, come back unchanged (same string), so the byte stream is
 * untouched unless an index is rewritten.
 */
export function repairSseLine(line: string, state: Map<number, ChoiceCalls>): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trim();
  if (payload === "" || payload === "[DONE]") return line;
  let chunk: StreamChunk;
  try {
    chunk = JSON.parse(payload) as StreamChunk;
  } catch {
    return line;
  }
  return repairToolCallIndices(chunk, state) ? `data: ${JSON.stringify(chunk)}` : line;
}

/**
 * Wrap a `fetch` so an event-stream response body has its tool-call indices
 * repaired line by line. Any other response passes through untouched.
 */
export function wrapFetchRepairingToolCallIndex(baseFetch: FetchLike, provider: string): FetchLike {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) return response;

    const state = new Map<number, ChoiceCalls>();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    let logged = false;
    const repairLine = (line: string): string => {
      const out = repairSseLine(line, state);
      if (out !== line && !logged) {
        logged = true;
        log.info("[model] repaired tool-call index", { provider });
      }
      return out;
    };
    const emitLines = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
      const lines = text.split("\n");
      pending = lines.pop() ?? "";
      if (lines.length === 0) return;
      const out = lines.map((raw) => {
        const cr = raw.endsWith("\r");
        const line = cr ? raw.slice(0, -1) : raw;
        return repairLine(line) + (cr ? "\r" : "");
      });
      controller.enqueue(encoder.encode(`${out.join("\n")}\n`));
    };

    const repaired = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          emitLines(pending + decoder.decode(chunk, { stream: true }), controller);
        },
        flush(controller) {
          const rest = pending + decoder.decode();
          pending = "";
          if (rest === "") return;
          const cr = rest.endsWith("\r");
          const line = cr ? rest.slice(0, -1) : rest;
          controller.enqueue(encoder.encode(repairLine(line) + (cr ? "\r" : "")));
        },
      }),
    );
    return new Response(repaired, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
