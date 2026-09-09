import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
} from "@ai-sdk/provider";

/**
 * One captured model call: the exact prompt + tools the engine sent to the
 * provider boundary on a single iteration.
 *
 * This is captured AFTER `applyCachePolicy` runs (the engine annotates the
 * prompt with cache breakpoints, then calls `model.doStream`), so it reflects
 * what actually goes on the wire — system message, growing message history,
 * and every `cache_control` marker — not the pre-policy assembly. That is the
 * load-bearing property for token-shape regression tests: the request the
 * provider sees is the thing that determines cost.
 */
export interface RecordedCall {
  prompt: LanguageModelV4Message[];
  tools: LanguageModelV4FunctionTool[];
}

export interface RecordingModel {
  /** Drop-in `LanguageModelV4` that records each call, then delegates to `inner`. */
  model: LanguageModelV4;
  /** Per-iteration captures, in call order. */
  calls: RecordedCall[];
}

/**
 * Wrap a `LanguageModelV4` so every `doStream` / `doGenerate` call is recorded
 * before delegating to the inner model. Pair with `createEchoModel` (scripted
 * responses) to drive a deterministic agentic loop and inspect the exact
 * per-step request the engine produced — no provider API involved.
 *
 * Captures are deep-cloned so later in-place mutations by the engine (it reuses
 * and extends the history array across iterations) can't corrupt earlier
 * records.
 */
export function recordingModel(inner: LanguageModelV4): RecordingModel {
  const calls: RecordedCall[] = [];

  function record(opts: LanguageModelV4CallOptions): void {
    const tools = (opts.tools ?? []).filter(
      (t): t is LanguageModelV4FunctionTool => t.type === "function",
    );
    calls.push(structuredClone({ prompt: opts.prompt, tools }));
  }

  const model: LanguageModelV4 = {
    ...inner,
    doGenerate(opts) {
      record(opts);
      return inner.doGenerate(opts);
    },
    doStream(opts) {
      record(opts);
      return inner.doStream(opts);
    },
  };

  return { model, calls };
}
