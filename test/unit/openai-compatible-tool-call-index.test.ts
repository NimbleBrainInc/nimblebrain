/**
 * Pins the `@ai-sdk/openai-compatible` behavior the nebius provider depends on.
 *
 * Nebius intermittently streams `openai/gpt-oss-120b`'s closing `arguments`
 * fragment on the next tool-call `index`, with no `id` and no `function.name`.
 * The adapter attaches such a fragment to the call still open; an adapter that
 * reads the unseen index as a new call fails the run with
 * `Expected 'id' to be a string.`
 */

import { describe, expect, it } from "bun:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ToolCallPart = Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;

function sse(chunks: object[]): string {
  return [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
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

async function streamParts(body: string): Promise<LanguageModelV4StreamPart[]> {
  const respond: FetchLike = async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  const provider = createOpenAICompatible({
    name: "nebius",
    apiKey: "test",
    baseURL: "https://gateway.example.test/v1",
    includeUsage: true,
    fetch: respond as typeof fetch,
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

describe("openai-compatible tool-call streaming", () => {
  it("attaches an id-less, name-less fragment on an unseen index to the open call", async () => {
    const parts = await streamParts(MISINDEXED);
    expect(parts.find((p) => p.type === "error")).toBeUndefined();
    const calls = parts.filter((p): p is ToolCallPart => p.type === "tool-call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolCallId).toBe("call_a");
    expect(calls[0]?.toolName).toBe("web_search");
    expect(JSON.parse(calls[0]?.input ?? "")).toEqual({ query: "acme corp hiring" });
  });

  it("keeps genuine parallel calls separate", async () => {
    const parts = await streamParts(PARALLEL);
    const calls = parts.filter((p): p is ToolCallPart => p.type === "tool-call");
    expect(calls.map((c) => [c.toolCallId, c.toolName, c.input])).toEqual([
      ["call_a", "a", '{"q":1}'],
      ["call_b", "b", '{"q":2}'],
    ]);
  });
});
