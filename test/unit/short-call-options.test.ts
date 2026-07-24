import { describe, expect, it } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { shortCallProviderOptions } from "../../src/model/short-call-options.ts";

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

describe("shortCallProviderOptions shape", () => {
  it("suppresses reasoning on the providers that expose a knob", () => {
    expect(shortCallProviderOptions("anthropic:claude-opus-5")).toEqual({
      anthropic: { effort: "low" },
    });
    expect(shortCallProviderOptions("google:gemini-2.5-pro")).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
    expect(shortCallProviderOptions("openai:gpt-5")).toEqual({
      openai: { reasoningEffort: "minimal" },
    });
  });

  it("returns empty for a null slot or a model outside the catalog", () => {
    expect(shortCallProviderOptions(null)).toEqual({});
    expect(shortCallProviderOptions("anthropic:not-a-real-model")).toEqual({});
  });
});
