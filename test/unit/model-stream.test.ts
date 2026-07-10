import { describe, expect, it } from "bun:test";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { withRetry } from "../../src/engine/retry.ts";
import { callModel, ModelStreamStallError } from "../../src/model/stream.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

function userPrompt(text: string): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user" as const, content: [{ type: "text" as const, text }] }],
  };
}

const sampleToolCall = {
  toolCallId: "call-1",
  toolName: "get_weather",
  input: JSON.stringify({ city: "Honolulu" }),
};

describe("callModel", () => {
  it("returns text content and calls onTextDelta", async () => {
    const model = createEchoModel();
    const deltas: string[] = [];

    const result = await callModel(model, userPrompt("hello"), (t) => deltas.push(t));

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(deltas).toContain("hello");
    expect(result.usage.inputTokens.total).toBeGreaterThan(0);
    expect(result.usage.outputTokens.total).toBeGreaterThan(0);
    expect(result.finishReason.unified).toBe("stop");
  });

  it("returns tool call content", async () => {
    const model = createEchoModel({
      responses: [{ toolCalls: [sampleToolCall] }],
    });
    const deltas: string[] = [];

    const result = await callModel(model, userPrompt("call tool"), (t) => deltas.push(t));

    const toolBlock = result.content.find((c) => c.type === "tool-call");
    expect(toolBlock).toBeDefined();
    expect(toolBlock).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "get_weather",
      input: JSON.stringify({ city: "Honolulu" }),
    });
    expect(result.finishReason.unified).toBe("tool-calls");
  });

  it("handles mixed text and tool call response", async () => {
    const model = createEchoModel({
      responses: [{ text: "thinking aloud", toolCalls: [sampleToolCall] }],
    });
    const deltas: string[] = [];

    const result = await callModel(model, userPrompt("mixed"), (t) => deltas.push(t));

    const textBlock = result.content.find((c) => c.type === "text");
    const toolBlock = result.content.find((c) => c.type === "tool-call");
    expect(textBlock).toEqual({ type: "text", text: "thinking aloud" });
    expect(toolBlock).toBeDefined();
    expect(deltas).toContain("thinking aloud");
  });

  it("accumulates text deltas into one content block", async () => {
    const model = createEchoModel();
    const deltas: string[] = [];

    const result = await callModel(model, userPrompt("accumulate"), (t) => deltas.push(t));

    // The echo model emits one delta per text block; callModel should produce exactly one text content block
    const textBlocks = result.content.filter((c) => c.type === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toEqual({ type: "text", text: "accumulate" });
  });

  it("emits tool-input start/end callbacks before the tool-call block", async () => {
    const model = createEchoModel({
      responses: [{ text: "preface", toolCalls: [sampleToolCall] }],
    });
    const events: string[] = [];

    await callModel(
      model,
      userPrompt("prep"),
      (t) => events.push(`text:${t}`),
      undefined,
      (id, name) => events.push(`prep-start:${id}:${name}`),
      (id) => events.push(`prep-end:${id}`),
    );

    // Tool-input start fires once per tool, with the tool name already known
    // (this is what lets the UI show "Calling X…" before execution begins).
    // Per-char tool-input-delta is intentionally swallowed in stream.ts —
    // verify by asserting only one start and one end event for this tool.
    const startEvents = events.filter((e) => e.startsWith("prep-start:"));
    const endEvents = events.filter((e) => e.startsWith("prep-end:"));
    expect(startEvents).toEqual([`prep-start:${sampleToolCall.toolCallId}:${sampleToolCall.toolName}`]);
    expect(endEvents).toEqual([`prep-end:${sampleToolCall.toolCallId}`]);

    // Order: text deltas precede prep-start (text emitted before tool-use
    // block in this fixture); prep-end precedes nothing relevant for this test
    // but must precede the assembled tool-call returned in result.content.
    const textIdx = events.findIndex((e) => e === "text:preface");
    const startIdx = events.indexOf(startEvents[0]);
    const endIdx = events.indexOf(endEvents[0]);
    expect(textIdx).toBeLessThan(startIdx);
    expect(startIdx).toBeLessThan(endIdx);
  });

  it("does not invoke tool-input callbacks for text-only responses", async () => {
    const model = createEchoModel();
    let starts = 0;
    let ends = 0;

    await callModel(
      model,
      userPrompt("no tools"),
      () => {},
      undefined,
      () => {
        starts++;
      },
      () => {
        ends++;
      },
    );

    expect(starts).toBe(0);
    expect(ends).toBe(0);
  });

  it("extracts nested usage structure", async () => {
    const model = createEchoModel();

    const result = await callModel(model, userPrompt("usage test"), () => {});

    expect(result.usage.inputTokens).toBeDefined();
    expect(result.usage.inputTokens.total).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeDefined();
    expect(result.usage.outputTokens.total).toBeGreaterThan(0);
    // Verify nested fields exist (even if undefined)
    expect("noCache" in result.usage.inputTokens).toBe(true);
    expect("cacheRead" in result.usage.inputTokens).toBe(true);
    expect("text" in result.usage.outputTokens).toBe(true);
    expect("reasoning" in result.usage.outputTokens).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stream idle watchdog
// ---------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/**
 * Minimal LanguageModelV3 whose per-call stream is scripted by the caller.
 * Each function produces the stream for one `doStream` invocation (the last
 * entry repeats) and receives the abortSignal so it can mirror a provider
 * aborting the underlying fetch.
 */
function scriptedModel(
  scripts: Array<(signal: AbortSignal | undefined) => ReadableStream<LanguageModelV3StreamPart>>,
): LanguageModelV3 {
  let call = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-1",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("doGenerate not used in these tests");
    },
    async doStream(options) {
      const script = scripts[Math.min(call, scripts.length - 1)];
      call += 1;
      return { stream: script(options.abortSignal) };
    },
  };
}

/** Opens then never progresses; errors when its signal aborts (mirrors the
 *  AI SDK aborting the fetch on `abortSignal`). */
function stallingStream(
  signal: AbortSignal | undefined,
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      const fail = () =>
        controller.error(signal?.reason ?? new DOMException("aborted", "AbortError"));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    },
  });
}

/** A complete, healthy single-shot text stream. */
function textStream(text: string): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "t0" });
      controller.enqueue({ type: "text-delta", id: "t0", delta: text });
      controller.enqueue({ type: "text-end", id: "t0" });
      controller.enqueue({ type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: undefined } });
      controller.close();
    },
  });
}

/** Text stream paced so each inter-part gap is `gapMs`. Total duration exceeds
 *  the idle window, but no single gap does — exercises the idle reset. */
function pacedStream(deltas: number, gapMs: number): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "t0" });
      let i = 0;
      const tick = () => {
        if (i < deltas) {
          controller.enqueue({ type: "text-delta", id: "t0", delta: "x" });
          i += 1;
          setTimeout(tick, gapMs);
        } else {
          controller.enqueue({ type: "text-end", id: "t0" });
          controller.enqueue({ type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: undefined } });
          controller.close();
        }
      };
      setTimeout(tick, gapMs);
    },
  });
}

/** Emits stream-start + one text-delta, then hangs — a stall AFTER output has
 *  begun. Errors when its signal aborts. */
function partialThenStallStream(
  signal: AbortSignal | undefined,
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "t0" });
      controller.enqueue({ type: "text-delta", id: "t0", delta: "partial" });
      const fail = () =>
        controller.error(signal?.reason ?? new DOMException("aborted", "AbortError"));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    },
  });
}

/** Model whose `doStream()` never resolves until the call is aborted — mirrors
 *  a connect / first-chunk hang (providers like Anthropic don't resolve
 *  doStream until the first SSE event arrives). */
function hangingDoStreamModel(): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-1",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("doGenerate not used in these tests");
    },
    async doStream(options) {
      const signal = options.abortSignal;
      await new Promise<never>((_, reject) => {
        const fail = () =>
          reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      });
      throw new Error("unreachable");
    },
  };
}

describe("callModel — stream idle watchdog", () => {
  it("throws a RETRYABLE stall when the stream never produces output", async () => {
    const model = scriptedModel([stallingStream]);
    const started = Date.now();
    const err = await callModel(
      model,
      userPrompt("x"),
      () => {},
      undefined,
      undefined,
      undefined,
      { firstContentMs: 50 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ModelStreamStallError);
    expect((err as ModelStreamStallError).retryable).toBe(true);
    // Fired on the first-content deadline, not the (absent) run wall clock.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("bounds a doStream() connect/first-chunk hang (armed before doStream)", async () => {
    // The provider's doStream doesn't resolve until the first SSE event; a hang
    // there must still be caught by the first-content deadline, retryable.
    const err = await callModel(
      hangingDoStreamModel(),
      userPrompt("x"),
      () => {},
      undefined,
      undefined,
      undefined,
      { firstContentMs: 50 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ModelStreamStallError);
    expect((err as ModelStreamStallError).retryable).toBe(true);
  });

  it("throws a NON-retryable stall when output already began (no delta re-stream)", async () => {
    // A stall after the first token is not retried: deltas are already on the
    // wire, and re-issuing would double-render them on the client.
    const deltas: string[] = [];
    const err = await callModel(
      scriptedModel([partialThenStallStream]),
      userPrompt("x"),
      (t) => deltas.push(t),
      undefined,
      undefined,
      undefined,
      { firstContentMs: 10_000, idleMs: 50 }, // idle governs once output starts
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ModelStreamStallError);
    expect((err as ModelStreamStallError).retryable).toBe(false);
    expect(deltas).toEqual(["partial"]); // the partial delta did stream
  });

  it("does NOT trip on a healthy but slow stream (idle resets per part)", async () => {
    // 5 deltas 30ms apart (~150ms total) against a 100ms idle window: total
    // duration exceeds idle, but every gap is under it. A total-call timeout
    // would wrongly kill this; the per-part idle must not.
    const model = scriptedModel([() => pacedStream(5, 30)]);
    const result = await callModel(
      model,
      userPrompt("x"),
      () => {},
      undefined,
      undefined,
      undefined,
      { firstContentMs: 10_000, idleMs: 100 },
    );
    expect(result.finishReason.unified).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "xxxxx" }]);
  });

  it("propagates a run-level abort as-is, not as a stall", async () => {
    const model = scriptedModel([stallingStream]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const err = await callModel(
      model,
      { ...userPrompt("x"), abortSignal: controller.signal },
      () => {},
      undefined,
      undefined,
      undefined,
      { firstContentMs: 10_000 }, // deadline far beyond the abort, so it can't win the race
    ).catch((e) => e);
    expect(err).not.toBeInstanceOf(ModelStreamStallError);
    expect(controller.signal.aborted).toBe(true);
  });

  it("recovers via withRetry: pre-output stall on the first call, succeed on the retry", async () => {
    const model = scriptedModel([stallingStream, () => textStream("recovered")]);
    const result = await withRetry(
      () =>
        callModel(model, userPrompt("x"), () => {}, undefined, undefined, undefined, {
          firstContentMs: 50,
        }),
      3,
      0,
    );
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
  });
});

// ---------------------------------------------------------------------------
// Time-to-first-token (TTFT)
// ---------------------------------------------------------------------------

/** stream-start then finish, with NO output part — an empty completion. */
function noOutputStream(): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: undefined } });
      controller.close();
    },
  });
}

/** First text-delta immediately, then a `gapMs` pause before the rest finishes.
 *  TTFT (first output) is near-zero; the LAST output part lands ~gapMs later — so
 *  a large ttft would prove the metric captured the wrong (last) part. */
function fastFirstThenGapStream(gapMs: number): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "t0" });
      controller.enqueue({ type: "text-delta", id: "t0", delta: "a" });
      setTimeout(() => {
        controller.enqueue({ type: "text-delta", id: "t0", delta: "b" });
        controller.enqueue({ type: "text-end", id: "t0" });
        controller.enqueue({ type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: undefined } });
        controller.close();
      }, gapMs);
    },
  });
}

/** Reasoning (thinking) tokens precede any text — the reasoning-heavy shape whose
 *  long decode is exactly what TTFT must see past. */
function reasoningFirstStream(): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "reasoning-start", id: "r0" });
      controller.enqueue({ type: "reasoning-delta", id: "r0", delta: "thinking" });
      controller.enqueue({ type: "reasoning-end", id: "r0" });
      controller.enqueue({ type: "text-start", id: "t0" });
      controller.enqueue({ type: "text-delta", id: "t0", delta: "answer" });
      controller.enqueue({ type: "text-end", id: "t0" });
      controller.enqueue({ type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: undefined } });
      controller.close();
    },
  });
}

describe("callModel — time-to-first-token", () => {
  it("sets ttftMs on a text response", async () => {
    const result = await callModel(scriptedModel([() => textStream("hi")]), userPrompt("x"), () => {});
    expect(typeof result.ttftMs).toBe("number");
    expect(result.ttftMs as number).toBeGreaterThanOrEqual(0);
  });

  it("measures the FIRST output part, not the last (regression: no inversion)", async () => {
    const gapMs = 200;
    const started = Date.now();
    const result = await callModel(
      scriptedModel([() => fastFirstThenGapStream(gapMs)]),
      userPrompt("x"),
      () => {},
    );
    const total = Date.now() - started;
    // The stream genuinely spanned the gap (so the next assertion is meaningful)...
    expect(total).toBeGreaterThanOrEqual(gapMs * 0.7);
    // ...yet TTFT is the FIRST token, well before the last output part at ~gapMs.
    // If it captured the last part, ttft would be ≈gapMs.
    expect(result.ttftMs).toBeDefined();
    expect(result.ttftMs as number).toBeLessThan(gapMs * 0.5);
  });

  it("leaves ttftMs undefined when the stream emits no output part", async () => {
    const result = await callModel(scriptedModel([noOutputStream]), userPrompt("x"), () => {});
    expect(result.content).toHaveLength(0);
    expect(result.ttftMs).toBeUndefined();
  });

  it("sets ttftMs on a reasoning-first response (first output is a reasoning delta)", async () => {
    const result = await callModel(scriptedModel([reasoningFirstStream]), userPrompt("x"), () => {});
    expect(typeof result.ttftMs).toBe("number");
  });

  it("sets ttftMs for a tool-only response (first output is tool-input-start)", async () => {
    const model = createEchoModel({ responses: [{ toolCalls: [sampleToolCall] }] });
    const result = await callModel(model, userPrompt("call tool"), () => {});
    expect(typeof result.ttftMs).toBe("number");
  });
});
