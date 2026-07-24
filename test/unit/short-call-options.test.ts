import { describe, expect, it } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { listModels } from "../../src/model/catalog.ts";
import { shortCallProviderOptions } from "../../src/model/short-call-options.ts";

/**
 * Anthropic reasoning models that get no options — they run no thinking unless
 * asked, so there is no budget-starvation failure to prevent, and sending
 * `effort` would change the request without buying anything (Haiku 4.5 and
 * Sonnet 4.5 would reject it outright; Opus 4.1 predates it). The mirror of
 * `THINKS_BY_DEFAULT` in the source — between them every Anthropic reasoning
 * model in the catalog must be accounted for.
 */
const NO_OPTIONS: ReadonlySet<string> = new Set([
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
]);

/**
 * These assert at the PROVIDER boundary — the JSON body handed to fetch — not
 * at `doGenerate`'s arguments.
 *
 * The distinction is the whole point of this file. An earlier revision passed
 * `thinking: {type: "disabled"}` for Anthropic and was verified by capturing
 * `options.providerOptions` inside a mock model. Those assertions were green
 * while the request on the wire was byte-identical to sending nothing:
 * `@ai-sdk/anthropic` serializes a `thinking` block only for `enabled` and
 * `adaptive`, and silently drops `disabled`. A test one layer too high
 * certified a fix that did not exist.
 */

/** Capture the request bodies an Anthropic model actually sends. */
function recordingAnthropic() {
  const bodies: Record<string, unknown>[] = [];
  const provider = createAnthropic({
    apiKey: "test",
    fetch: (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "A Title" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });
  return { provider, bodies };
}

const PROMPT = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

describe("shortCallProviderOptions on the wire (anthropic)", () => {
  it("emits output_config.effort for a reasoning model", async () => {
    const { provider, bodies } = recordingAnthropic();
    await provider("claude-opus-5").doGenerate({
      prompt: PROMPT,
      maxOutputTokens: 512,
      providerOptions: shortCallProviderOptions("anthropic:claude-opus-5"),
    });

    expect(bodies[0]!.output_config).toEqual({ effort: "low" });
  });

  it("does NOT reach the wire via thinking.type=disabled", async () => {
    // Regression guard for the revision this file's header describes. If a
    // future provider release starts serializing `disabled`, this fails and
    // the Anthropic arm can be revisited — it is strictly better than effort.
    const { provider, bodies } = recordingAnthropic();
    const model = provider("claude-opus-5");
    await model.doGenerate({
      prompt: PROMPT,
      maxOutputTokens: 512,
      providerOptions: { anthropic: { thinking: { type: "disabled" } } },
    });
    await model.doGenerate({ prompt: PROMPT, maxOutputTokens: 512 });

    expect(bodies[0]).toEqual(bodies[1]!);
    expect(bodies[0]!.thinking).toBeUndefined();
  });

  it("sends NO effort to the default fast model", async () => {
    // Haiku 4.5 reasons but rejects `output_config.effort`, and it is what
    // every short call resolves to out of the box (DEFAULT_FAST_MODEL, all
    // three .environments/ seeds, and the documented models.fast default).
    // The provider serializes `effort` with no per-model gating, so gating on
    // capabilities.reasoning alone would put a rejected parameter on the
    // runtime's highest-frequency paths.
    const { provider, bodies } = recordingAnthropic();
    await provider("claude-haiku-4-5-20251001").doGenerate({
      prompt: PROMPT,
      maxOutputTokens: 512,
      providerOptions: shortCallProviderOptions("anthropic:claude-haiku-4-5-20251001"),
    });

    expect(bodies[0]!.output_config).toBeUndefined();
    expect(bodies[0]!.thinking).toBeUndefined();
  });

  it("sends nothing extra for a non-reasoning model or an unknown slot", async () => {
    const { provider, bodies } = recordingAnthropic();
    const model = provider("claude-opus-5");
    await model.doGenerate({
      prompt: PROMPT,
      maxOutputTokens: 512,
      providerOptions: shortCallProviderOptions(null),
    });
    await model.doGenerate({
      prompt: PROMPT,
      maxOutputTokens: 512,
      providerOptions: shortCallProviderOptions("anthropic:not-a-real-model"),
    });

    expect(bodies[0]!.output_config).toBeUndefined();
    expect(bodies[1]!.output_config).toBeUndefined();
  });
});

describe("engine thinking options on the wire", () => {
  // `buildAnthropicThinkingOptions` translates the platform's enabled+budget
  // into adaptive+effort for adaptive-only models. engine.test.ts asserts the
  // options object; this asserts the two facts that translation depends on —
  // that `xhigh` survives serialization, and that bare adaptive sends no
  // effort at all.
  it("serializes adaptive + xhigh into thinking and output_config", async () => {
    const { provider, bodies } = recordingAnthropic();
    await provider("claude-opus-5").doGenerate({
      prompt: PROMPT,
      maxOutputTokens: 1024,
      providerOptions: { anthropic: { thinking: { type: "adaptive" }, effort: "xhigh" } },
    });

    expect(bodies[0]!.thinking).toEqual({ type: "adaptive" });
    expect(bodies[0]!.output_config).toEqual({ effort: "xhigh" });
  });

  it("sends no output_config for bare adaptive", async () => {
    const { provider, bodies } = recordingAnthropic();
    await provider("claude-opus-5").doGenerate({
      prompt: PROMPT,
      maxOutputTokens: 1024,
      providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
    });

    expect(bodies[0]!.thinking).toEqual({ type: "adaptive" });
    expect(bodies[0]!.output_config).toBeUndefined();
  });
});

describe("shortCallProviderOptions shape", () => {
  it("suppresses reasoning on the providers that expose a knob", () => {
    expect(shortCallProviderOptions("anthropic:claude-opus-5")).toEqual({
      anthropic: { effort: "low" },
    });
    expect(shortCallProviderOptions("anthropic:claude-sonnet-5")).toEqual({
      anthropic: { effort: "low" },
    });
    expect(shortCallProviderOptions("google:gemini-2.5-pro")).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
    expect(shortCallProviderOptions("openai:gpt-5")).toEqual({
      openai: { reasoningEffort: "minimal" },
    });
  });

  it("returns nothing for a null slot or a model outside the catalog", () => {
    expect(shortCallProviderOptions(null)).toBeUndefined();
    expect(shortCallProviderOptions("anthropic:not-a-real-model")).toBeUndefined();
  });

  it("returns nothing for Anthropic reasoning models that don't think uninvited", () => {
    for (const id of NO_OPTIONS) {
      expect(shortCallProviderOptions(`anthropic:${id}`)).toBeUndefined();
    }
  });

  it("classifies every Anthropic reasoning model for output_config.effort", () => {
    // Companion to the ADAPTIVE_ONLY_THINKING_MODELS guard in catalog.test.ts,
    // and the same failure shape: `sync-models` adds Anthropic models
    // automatically, but effort support is hand-maintained because models.dev
    // doesn't track it. An unclassified model silently gets no options here —
    // safe, but it means an operator pointing `fast` at it loses the
    // protection without any signal.
    //
    // To fix a failure: decide whether the model thinks when `thinking` is
    // omitted, then add it to THINKS_BY_DEFAULT in
    // src/model/short-call-options.ts or to NO_OPTIONS above.
    const unclassified = listModels("anthropic")
      .filter((m) => m.capabilities.reasoning)
      .filter((m) => shortCallProviderOptions(`anthropic:${m.id}`) === undefined)
      .map((m) => m.id)
      .filter((id) => !NO_OPTIONS.has(id));

    expect(unclassified).toEqual([]);
  });
});
