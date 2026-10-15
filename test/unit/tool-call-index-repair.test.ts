import { describe, expect, it } from "bun:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  repairSseLine,
  wrapFetchRepairingToolCallIndex,
} from "../../src/model/tool-call-index-repair.ts";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function sse(chunks: object[]): string[] {
  return [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"];
}

function streamingResponse(parts: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(toolCalls: object[], finishReason: string | null = null): object {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-oss-120b",
    choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: finishReason }],
  };
}

const USAGE = {
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "gpt-oss-120b",
  choices: [],
  usage: { prompt_tokens: 138, completion_tokens: 60, total_tokens: 198 },
};

/**
 * The stream shape Nebius returned for gpt-oss-120b: a call opened on index 0,
 * and its closing fragment, which carries the finish reason, on index 1 with
 * no id or name.
 */
const MISINDEXED = sse([
  chunk([
    { id: "call_a", type: "function", index: 0, function: { name: "web_search", arguments: "" } },
  ]),
  chunk([{ index: 0, function: { arguments: '{\n  "query":' } }]),
  chunk([{ index: 0, function: { arguments: ' "acme corp' } }]),
  chunk([{ index: 1, function: { arguments: ' hiring"\n}' } }], "tool_calls"),
  USAGE,
]);

/** Two genuine parallel calls, each opened with its own id and name. */
const PARALLEL = sse([
  chunk([{ id: "call_a", type: "function", index: 0, function: { name: "a", arguments: "" } }]),
  chunk([{ index: 0, function: { arguments: '{"q":1}' } }]),
  chunk([{ id: "call_b", type: "function", index: 1, function: { name: "b", arguments: "" } }]),
  chunk([{ index: 1, function: { arguments: '{"q":2}' } }], "tool_calls"),
  USAGE,
]);

async function streamToolCalls(body: string[], wrap: boolean) {
  const base: FetchLike = async () => streamingResponse(body);
  const provider = createOpenAICompatible({
    name: "nebius",
    apiKey: "test",
    baseURL: "https://gateway.example.test/v1",
    includeUsage: true,
    fetch: (wrap ? wrapFetchRepairingToolCallIndex(base, "nebius") : base) as typeof fetch,
  });
  const { stream } = await provider.languageModel("openai/gpt-oss-120b").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "search" }] }],
    tools: [
      {
        type: "function",
        name: "web_search",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
  });
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

describe("repairSseLine", () => {
  it("moves an id-less, name-less fragment on an unopened index onto the latest call", () => {
    const state = new Map();
    repairSseLine(
      `data: ${JSON.stringify(chunk([{ id: "x", index: 0, function: { name: "f", arguments: "" } }]))}`,
      state,
    );
    const out = repairSseLine(
      `data: ${JSON.stringify(chunk([{ index: 1, function: { arguments: "}" } }]))}`,
      state,
    );
    expect(JSON.parse(out.slice(5)).choices[0].delta.tool_calls[0].index).toBe(0);
  });

  it("returns a well-formed line byte-for-byte", () => {
    const state = new Map();
    const line = `data: ${JSON.stringify(chunk([{ id: "x", index: 0, function: { name: "f" } }]))}`;
    expect(repairSseLine(line, state)).toBe(line);
    const cont = `data:${JSON.stringify(chunk([{ index: 0, function: { arguments: "{}" } }]))}`;
    expect(repairSseLine(cont, state)).toBe(cont);
  });

  it("leaves non-data lines, [DONE] and unparseable payloads alone", () => {
    const state = new Map();
    for (const line of ["event: ping", "", "data: [DONE]", "data: {not json", ": comment"]) {
      expect(repairSseLine(line, state)).toBe(line);
    }
  });

  it("does not repair a fragment when no call has been opened", () => {
    const state = new Map();
    const line = `data: ${JSON.stringify(chunk([{ index: 1, function: { arguments: "}" } }]))}`;
    expect(repairSseLine(line, state)).toBe(line);
  });
});

describe("wrapFetchRepairingToolCallIndex", () => {
  it("the unrepaired stream fails in the adapter's parser", async () => {
    let failure: unknown;
    try {
      const parts = await streamToolCalls(MISINDEXED, false);
      failure = (parts.find((p) => p.type === "error") as { error: unknown } | undefined)?.error;
    } catch (err) {
      failure = err;
    }
    expect(String(failure)).toContain("Expected 'id' to be a string.");
  });

  it("a misindexed closing fragment becomes one complete tool call with a stable id", async () => {
    expectOneRepairedCall(await streamToolCalls(MISINDEXED, true));
  });

  it("keeps genuine parallel calls separate", async () => {
    const parts = await streamToolCalls(PARALLEL, true);
    const calls = parts.filter((p) => p.type === "tool-call") as Extract<
      LanguageModelV4StreamPart,
      { type: "tool-call" }
    >[];
    expect(calls.map((c) => [c.toolCallId, c.toolName, c.input])).toEqual([
      ["call_a", "a", '{"q":1}'],
      ["call_b", "b", '{"q":2}'],
    ]);
  });

  it("repairs a misindexed line split across byte chunks", async () => {
    const whole = MISINDEXED.join("");
    const mid = whole.indexOf('"index":1');
    expectOneRepairedCall(await streamToolCalls([whole.slice(0, mid), whole.slice(mid)], true));
  });

  it("repairs a CRLF stream delivered one byte at a time", async () => {
    const crlf = MISINDEXED.join("").replaceAll("\n\n", "\r\n\r\n");
    expectOneRepairedCall(await streamToolCalls([...crlf], true));
  });

  it("passes a non-event-stream response through untouched", async () => {
    const original = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const base: FetchLike = async () => original;
    const res = await wrapFetchRepairingToolCallIndex(base, "nebius")("https://x");
    expect(res).toBe(original);
  });
});

/** The repaired MISINDEXED stream: one call with the opening id, the name, and the full arguments. */
function expectOneRepairedCall(parts: LanguageModelV4StreamPart[]): void {
  expect(parts.find((p) => p.type === "error")).toBeUndefined();
  const calls = parts.filter((p) => p.type === "tool-call");
  expect(calls).toHaveLength(1);
  const call = calls[0] as Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;
  expect(call.toolCallId).toBe("call_a");
  expect(call.toolName).toBe("web_search");
  expect(JSON.parse(call.input)).toEqual({ query: "acme corp hiring" });
}
