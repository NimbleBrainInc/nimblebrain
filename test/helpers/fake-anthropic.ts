/**
 * A stand-in for Anthropic's Messages API, streaming its real wire format, so a
 * test drives a real Anthropic provider (the AI SDK's, in this process or in an
 * agent's) through its base URL with no network and no key.
 *
 * It answers like a minimal agent: offered tools and holding no tool result
 * yet, it calls the first tool with `toolInput`; otherwise it replies in text,
 * echoing the last tool result when there is one. The same request gets the
 * same reply, so two runtimes pointed at it see the same model.
 */

interface MessagesRequest {
  tools?: { name: string }[];
  messages: {
    role: string;
    content: string | { type: string; content?: unknown; text?: string }[];
  }[];
}

export interface FakeAnthropic {
  /** The provider base URL (`…/v1`), for `baseURL` or `ANTHROPIC_BASE_URL`. */
  baseUrl: string;
  /** The server's root, standing in for a model gateway's (`execution.modelGateway`). */
  rootUrl: string;
  requests: MessagesRequest[];
  /** Each request's `Authorization` header (`null` when absent), in the same order. */
  authorizations: (string | null)[];
  /** Each request's path, in the same order. */
  paths: string[];
  /** Each request's `x-api-key` header (`null` when absent), in the same order. */
  apiKeys: (string | null)[];
  close(): Promise<void>;
}

export interface FakeAnthropicOptions {
  /** The arguments of the tool call, as JSON. */
  toolInput: string;
}

export function startFakeAnthropic(opts: FakeAnthropicOptions): FakeAnthropic {
  const requests: MessagesRequest[] = [];
  const authorizations: (string | null)[] = [];
  const paths: string[] = [];
  const apiKeys: (string | null)[] = [];
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/messages"))
        return new Response(null, { status: 404 });
      const body = (await req.json()) as MessagesRequest;
      requests.push(body);
      authorizations.push(req.headers.get("authorization"));
      paths.push(new URL(req.url).pathname);
      apiKeys.push(req.headers.get("x-api-key"));
      return new Response(stream(reply(body, opts)), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${http.port}/v1`,
    rootUrl: `http://127.0.0.1:${http.port}`,
    requests,
    authorizations,
    paths,
    apiKeys,
    close: async () => {
      await http.stop(true);
    },
  };
}

type Reply = { kind: "text"; text: string } | { kind: "tool"; name: string; input: string };

function reply(body: MessagesRequest, opts: FakeAnthropicOptions): Reply {
  const last = body.messages.at(-1);
  const parts = Array.isArray(last?.content) ? last.content : [];
  const result = parts.find((p) => p.type === "tool_result");
  if (result) {
    const content = result.content;
    const text = Array.isArray(content)
      ? content.map((c: { text?: string }) => c.text ?? "").join("")
      : String(content ?? "");
    return { kind: "text", text: `The tool says: ${text}` };
  }
  const tool = body.tools?.[0];
  if (tool) return { kind: "tool", name: tool.name, input: opts.toolInput };
  return { kind: "text", text: "Hello from the fake model." };
}

type Sse = [event: string, data: unknown];

function textEvents(text: string): Sse[] {
  return [
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    ],
  ];
}

function toolEvents(name: string, input: string): Sse[] {
  return [
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_fake", name, input: {} },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: input },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    ],
  ];
}

function stream(r: Reply): ReadableStream<Uint8Array> {
  const start: Sse = [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
  ];
  const body = r.kind === "text" ? textEvents(r.text) : toolEvents(r.name, r.input);
  const events: Sse[] = [start, ...body, ["message_stop", { type: "message_stop" }]];
  const text = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(text).body as ReadableStream<Uint8Array>;
}
