import { describe, expect, it } from "bun:test";
import {
  resolveModelString,
  buildRegistry,
  buildModelResolver,
} from "../../src/model/registry.ts";

describe("resolveModelString", () => {
  it("looks up bare anthropic model id in the catalog", () => {
    expect(resolveModelString("claude-sonnet-4-6")).toBe(
      "anthropic:claude-sonnet-4-6",
    );
  });

  it("looks up bare google model id in the catalog (fixes UI sending bare gemini ids to anthropic)", () => {
    // Regression: the settings UI used to write `gemini-3.1-pro-preview`
    // as the saved value (no `google:` prefix). Without the catalog
    // fallback, that id defaulted to `anthropic:` and 404'd against
    // the Anthropic API.
    expect(resolveModelString("gemini-3.1-pro-preview")).toBe(
      "google:gemini-3.1-pro-preview",
    );
  });

  it("looks up bare openai model id in the catalog", () => {
    expect(resolveModelString("gpt-4o")).toBe("openai:gpt-4o");
  });

  it("falls back to anthropic for bare ids not in the catalog (backward compat)", () => {
    // Bespoke / pinned model ids that pre-date the catalog still default
    // to anthropic — preserves the historical behavior for tenants who
    // configured custom model strings.
    expect(resolveModelString("custom-fine-tune-not-in-catalog")).toBe(
      "anthropic:custom-fine-tune-not-in-catalog",
    );
  });

  it("leaves already-qualified openai string unchanged", () => {
    expect(resolveModelString("openai:gpt-4o")).toBe("openai:gpt-4o");
  });

  it("leaves already-qualified google string unchanged", () => {
    expect(resolveModelString("google:gemini-2.5-flash")).toBe(
      "google:gemini-2.5-flash",
    );
  });

  it("keeps strings with multiple colons unchanged", () => {
    expect(resolveModelString("openai:ft:gpt-4o:my-org")).toBe(
      "openai:ft:gpt-4o:my-org",
    );
  });
});

describe("buildRegistry", () => {
  it("creates a provider that resolves anthropic models with correct spec version", () => {
    const registry = buildRegistry({ providers: { anthropic: {} } });
    const model = registry.languageModel("anthropic:claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toContain("anthropic");
    expect(model.modelId).toContain("claude-sonnet");
  });

  it("defaults to anthropic when no providers configured", () => {
    const registry = buildRegistry({});
    const model = registry.languageModel("anthropic:claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model.provider).toContain("anthropic");
    // Verify it has the same spec version as explicit config
    expect(model.specificationVersion).toBe("v3");
  });

  it("throws for unregistered provider prefix", () => {
    const registry = buildRegistry({ providers: { anthropic: {} } });
    expect(() => registry.languageModel("fakeprovider:some-model")).toThrow();
  });

  it("resolves nebius models through the OpenAI-compatible Chat Completions API", () => {
    const registry = buildRegistry({ providers: { nebius: { apiKey: "nb-test-key" } } });
    const model = registry.languageModel("nebius:deepseek-ai/DeepSeek-V4-Pro");
    expect(model).toBeDefined();
    expect(model.specificationVersion).toBe("v3");
    // Chat Completions, which this adapter binds natively — Nebius serves no
    // Responses API. Pinned so a swap back to a Responses-defaulting adapter
    // fails here rather than at the first chat turn.
    expect(model.provider).toBe("nebius.chat");
    expect(model.modelId).toBe("deepseek-ai/DeepSeek-V4-Pro");
  });

  it("fails closed when nebius is configured without a key", () => {
    // Not a leak guard any more — this adapter has no OPENAI_API_KEY fallback
    // to leak through. Kept because a boot-time throw beats an unauthenticated
    // 401 on the first chat turn.
    const prev = process.env.NEBIUS_API_KEY;
    process.env.NEBIUS_API_KEY = "";
    try {
      expect(() => buildRegistry({ providers: { nebius: {} } })).toThrow(/nebius.*no API key/i);
    } finally {
      if (prev === undefined) delete process.env.NEBIUS_API_KEY;
      else process.env.NEBIUS_API_KEY = prev;
    }
  });

  it("resolves xai models through Chat Completions", () => {
    const registry = buildRegistry({ providers: { xai: { apiKey: "xai-test-key" } } });
    const model = registry.languageModel("xai:grok-4.5");
    expect(model).toBeDefined();
    expect(model.specificationVersion).toBe("v3");
    // `.languageModel()` binds Chat Completions on this adapter version; the
    // Responses API is opt-in via `.responses()`. Pinned so a dependency bump
    // that moves that default fails here rather than silently changing which
    // API the runtime talks to.
    expect(model.provider).toBe("xai.chat");
    expect(model.modelId).toBe("grok-4.5");
  });

  it("does not fail closed when xai has no key, unlike nebius", () => {
    // createXai falls back to XAI_API_KEY — its own variable — so an absent
    // config key is the normal, working case and there is nothing to fail on.
    // Nebius throws because its adapter has no env fallback of its own, so a
    // missing key there is a misconfiguration with no path forward. Asserted so
    // nobody "unifies" the two branches on symmetry grounds.
    const prev = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "";
    try {
      expect(() => buildRegistry({ providers: { xai: {} } })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prev;
    }
  });
});

describe("buildModelResolver", () => {
  it("returns a function", () => {
    const resolver = buildModelResolver({ providers: { anthropic: {} } });
    expect(typeof resolver).toBe("function");
  });

  it("resolves bare strings with anthropic prefix", () => {
    const resolver = buildModelResolver({ providers: { anthropic: {} } });
    const model = resolver("claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model.provider).toContain("anthropic");
  });

  it("resolves qualified strings directly", () => {
    const resolver = buildModelResolver({ providers: { anthropic: {} } });
    const model = resolver("anthropic:claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model.provider).toContain("anthropic");
    expect(model.modelId).toContain("claude-sonnet-4-6");
  });
});

describe("nebius request shape", () => {
  /**
   * An adapter swap's blast radius is the request body, so assert the body —
   * not just which class got constructed. `createOpenAICompatible` is generic:
   * everything `createOpenAI` did unconditionally has to be asked for by name
   * here, and each omission fails silently on a different axis (metering,
   * structured output, options routing).
   *
   * Goes through `buildRegistry` rather than the adapter directly, because the
   * flags under test live at that call site and nothing else would catch their
   * removal.
   */
  async function captureNebiusRequest(
    call: (model: ReturnType<typeof buildModelResolver>) => Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    const realFetch = globalThis.fetch;
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    try {
      await call(buildModelResolver({ providers: { nebius: { apiKey: "nb-test-key" } } }));
    } finally {
      globalThis.fetch = realFetch;
    }
    return body;
  }

  it("asks for streaming usage, or every turn meters at zero", async () => {
    // Measured against live Nebius: without `stream_options.include_usage` it
    // returns `"usage": null` on every chunk, and the engine only ever streams.
    // The resulting all-zero TokenUsage is indistinguishable from a free turn.
    const body = await captureNebiusRequest((resolve) =>
      resolve("nebius:Qwen/Qwen3-32B").doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      }),
    );
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("sends a schema-bearing response_format as json_schema, not json_object", async () => {
    // The home briefing sends a schema on every generation. Without
    // `supportsStructuredOutputs` the adapter drops it to `{type:"json_object"}`
    // — no schema, no strict decoding.
    const body = await captureNebiusRequest((resolve) =>
      resolve("nebius:Qwen/Qwen3-32B").doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        responseFormat: {
          type: "json",
          name: "briefing",
          schema: { type: "object", properties: { lede: { type: "string" } } },
        },
      }),
    );
    expect((body.response_format as { type: string }).type).toBe("json_schema");
  });

  it("routes reasoning effort from the nebius options key onto the wire", async () => {
    // The engine-side test proves which key is emitted; this proves it survives
    // to the request. An `openai` key would vanish here with no error.
    const body = await captureNebiusRequest((resolve) =>
      resolve("nebius:Qwen/Qwen3-32B").doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        providerOptions: { nebius: { reasoningEffort: "low" } },
      }),
    );
    expect(body.reasoning_effort).toBe("low");
  });
});
