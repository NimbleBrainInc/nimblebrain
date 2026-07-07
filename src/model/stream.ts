import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import { withSpan } from "../observability/index.ts";

/**
 * The watchdog bounds a single model stream in two regimes, because time-to-
 * first-token and inter-token latency have different physics:
 *
 * - **First content** — connect + prefill + first token. Prefill time scales
 *   with input size (a large cold-cache prompt can take many seconds to first
 *   token, and Anthropic's keep-alive `ping`s are swallowed by the provider,
 *   so a healthy prefill looks silent to us). This deadline must be generous
 *   enough not to trip a live-but-slow start, yet still bound a connect/first-
 *   chunk hang — which on the chat path has no run wall clock behind it.
 * - **Idle (inter-part)** — once tokens are flowing, a gap this long is a
 *   genuine stall (healthy inter-token gaps are sub-second). Reset on every
 *   part, so a healthy long generation (extended thinking, large output) never
 *   trips it.
 *
 * Both sit below a typical run budget so a stall is caught (and the pre-content
 * case retried) with room to spare, instead of the whole run blocking on one
 * hung call until `maxRunDurationMs`.
 */
export const MODEL_STREAM_FIRST_CONTENT_TIMEOUT_MS = 90_000;
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 45_000;

/** Per-call watchdog overrides (defaults are the two constants above). */
export interface StreamWatchdogConfig {
  firstContentMs?: number;
  idleMs?: number;
}

/**
 * Thrown when a model stream makes no progress within the watchdog deadline
 * (see {@link MODEL_STREAM_FIRST_CONTENT_TIMEOUT_MS} / {@link MODEL_STREAM_IDLE_TIMEOUT_MS}).
 *
 * `retryable` is true ONLY when the stall happened before the model emitted any
 * output: such a stall is almost always transient upstream and the call is
 * idempotent (no side effects until tool execution) AND no deltas reached the
 * client, so `withRetry` can re-issue cleanly. A stall AFTER output started is
 * NOT retryable — deltas are already on the wire, and re-issuing would
 * re-stream them. A run-level cancellation (external abort) is not a stall and
 * propagates unchanged.
 */
export class ModelStreamStallError extends Error {
  readonly retryable: boolean;
  constructor(deadlineMs: number, opts: { retryable: boolean }) {
    super(
      `Model stream stalled: no ${opts.retryable ? "response" : "further output"} for ${deadlineMs}ms`,
    );
    this.name = "ModelStreamStallError";
    this.retryable = opts.retryable;
  }
}

export interface StreamResult {
  content: LanguageModelV3Content[];
  usage: LanguageModelV3Usage;
  finishReason: LanguageModelV3FinishReason;
}

/** Sink callbacks invoked as deltas stream, before the final StreamResult is assembled. */
interface StreamCallbacks {
  onTextDelta: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onToolInputStart?: (id: string, toolName: string) => void;
  onToolInputEnd?: (id: string) => void;
}

/** Mutable accumulator folded over the stream parts to build a StreamResult. */
interface StreamState {
  content: LanguageModelV3Content[];
  usage: LanguageModelV3Usage;
  finishReason: LanguageModelV3FinishReason;
  accumulatedText: string;
  accumulatedReasoning: string;
  // Reasoning provider metadata accumulator. Anthropic transports the
  // thinking-block signature as a separate `signature_delta` event that
  // the AI SDK forwards as a `reasoning-delta` with empty text and
  // `providerMetadata.anthropic.signature`. Without persisting that
  // signature, the next iteration's prompt fails to round-trip the
  // reasoning block — the AI SDK provider drops it as "unsupported
  // reasoning metadata" and Anthropic 400s the request.
  reasoningProviderMetadata: SharedV3ProviderMetadata | undefined;
}

/**
 * Trace one model call as an `llm.call` span nested under the active
 * `agent.turn`. Attributes are operational only — model id, provider, token
 * counts, finish reason. Prompt and completion content are NEVER recorded.
 */
export async function callModel(
  model: LanguageModelV3,
  options: LanguageModelV3CallOptions,
  onTextDelta: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  onToolInputStart?: (id: string, toolName: string) => void,
  onToolInputEnd?: (id: string) => void,
  watchdogConfig: StreamWatchdogConfig = {},
): Promise<StreamResult> {
  return withSpan(
    "llm.call",
    { "llm.model": model.modelId, "llm.provider": model.provider },
    async (span) => {
      const result = await callModelInner(
        model,
        options,
        onTextDelta,
        onReasoningDelta,
        onToolInputStart,
        onToolInputEnd,
        watchdogConfig,
      );
      span.setAttrs({
        "llm.tokens.input": result.usage.inputTokens.total ?? 0,
        "llm.tokens.output": result.usage.outputTokens.total ?? 0,
        "llm.finish_reason": result.finishReason.unified,
      });
      return result;
    },
  );
}

async function callModelInner(
  model: LanguageModelV3,
  options: LanguageModelV3CallOptions,
  onTextDelta: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  /**
   * Called once when the model begins emitting a tool-call block, with
   * the tool name already known. Lets the engine surface "Calling X…"
   * during the dark gap where the model is streaming a large tool
   * input — `tool.start` only fires after `callModel` returns.
   *
   * Provider-agnostic: AI SDK V3 normalizes `tool-input-start` across
   * Anthropic / OpenAI / Google. Providers that never emit it simply
   * skip the callback (engine falls back to `tool.start`-only signals,
   * matching legacy behavior).
   */
  onToolInputStart?: (id: string, toolName: string) => void,
  onToolInputEnd?: (id: string) => void,
  watchdogConfig: StreamWatchdogConfig = {},
): Promise<StreamResult> {
  const firstContentMs = watchdogConfig.firstContentMs ?? MODEL_STREAM_FIRST_CONTENT_TIMEOUT_MS;
  const idleMs = watchdogConfig.idleMs ?? MODEL_STREAM_IDLE_TIMEOUT_MS;

  const state: StreamState = {
    content: [],
    usage: {
      inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 0, text: undefined, reasoning: undefined },
    },
    // Default if the stream ends without a `finish` part. "other" is the
    // V3-defined catch-all for unclassified stops; using it directly avoids
    // the runtime-vs-type lie of `"unknown" as "other"`.
    finishReason: { unified: "other", raw: undefined },
    accumulatedText: "",
    accumulatedReasoning: "",
    reasoningProviderMetadata: undefined,
  };
  const callbacks: StreamCallbacks = {
    onTextDelta,
    onReasoningDelta,
    onToolInputStart,
    onToolInputEnd,
  };

  const watchdog = createStreamWatchdog(options.abortSignal, { firstContentMs, idleMs });
  try {
    // Arm BEFORE doStream: for some providers (e.g. Anthropic) `doStream` does
    // not resolve until the first stream event arrives, so a connect / first-
    // chunk hang lives entirely inside this await. On the chat path there is no
    // run wall clock to catch it, so the first-content deadline must.
    watchdog.arm();
    const { stream } = await model.doStream({ ...options, abortSignal: watchdog.signal });
    await pumpStream(stream, state, callbacks, watchdog);
  } catch (err) {
    // Our watchdog fired (the stream stalled) and the run itself was NOT
    // cancelled → surface a stall. Retryable only before output began; a
    // genuine run-level abort (external signal) is not a stall — propagate it.
    if (watchdog.stalled && !options.abortSignal?.aborted) {
      const sawOutput = watchdog.sawOutput;
      throw new ModelStreamStallError(sawOutput ? idleMs : firstContentMs, {
        retryable: !sawOutput,
      });
    }
    throw err;
  } finally {
    watchdog.dispose();
  }

  // Drain any in-flight accumulators that didn't see their -end part.
  flushText(state);
  flushReasoning(state);

  return { content: state.content, usage: state.usage, finishReason: state.finishReason };
}

/**
 * Read the stream to completion, folding each part into `state` and re-arming
 * the watchdog on every part (switching to the idle regime once output begins).
 * Returns when the stream ends; rejects if a read is aborted (stall or cancel).
 */
async function pumpStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  state: StreamState,
  callbacks: StreamCallbacks,
  watchdog: StreamWatchdog,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value: part } = await reader.read();
      if (done) break;
      if (isOutputPart(part)) watchdog.noteOutput();
      watchdog.arm();
      applyPart(state, part, callbacks);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Bounds a single model stream: one `AbortController` aborts the stream when
 * EITHER the run-level signal fires (cancel / wall clock) OR the deadline
 * elapses without progress. Its `signal` is handed to `doStream` in place of
 * the raw run signal, so a stall cancels the underlying fetch exactly like a
 * cancel does. `noteOutput()` flips it from the generous first-content deadline
 * (prefill is slow, scales with prompt size) to the tight inter-part idle, and
 * marks any later stall non-retryable (deltas already reached the client).
 */
interface StreamWatchdog {
  /** Signal to hand to `doStream`. */
  readonly signal: AbortSignal;
  /** True once the model has emitted its first output part. */
  readonly sawOutput: boolean;
  /** True if THIS watchdog's deadline fired (vs the run-level signal). */
  readonly stalled: boolean;
  /** (Re)arm the deadline for the next part — first-content or idle by phase. */
  arm(): void;
  /** Record that output has begun (switch to the idle regime; idempotent). */
  noteOutput(): void;
  /** Clear the timer and detach the run-signal listener. */
  dispose(): void;
}

function createStreamWatchdog(
  externalSignal: AbortSignal | undefined,
  deadlines: { firstContentMs: number; idleMs: number },
): StreamWatchdog {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let sawOutput = false;
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    signal: controller.signal,
    get sawOutput() {
      return sawOutput;
    },
    get stalled() {
      return stalled;
    },
    arm(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(
        () => {
          stalled = true;
          controller.abort();
        },
        sawOutput ? deadlines.idleMs : deadlines.firstContentMs,
      );
    },
    noteOutput(): void {
      sawOutput = true;
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * A part that marks the model as actively producing output — the boundary
 * between the prefill regime and the streaming regime. These are exactly the
 * parts that fire a client-visible delta callback, so once one has been seen a
 * stall is non-retryable (its deltas already reached the client). Structural
 * parts (`stream-start`, `text-start`, `finish`, …) don't count.
 */
function isOutputPart(part: LanguageModelV3StreamPart): boolean {
  return (
    part.type === "text-delta" ||
    part.type === "reasoning-delta" ||
    part.type === "tool-input-start" ||
    part.type === "tool-input-end"
  );
}

/** Fold one stream part into the accumulating StreamState, emitting deltas via the callbacks. */
function applyPart(
  state: StreamState,
  part: LanguageModelV3StreamPart,
  callbacks: StreamCallbacks,
): void {
  switch (part.type) {
    case "text-start":
      state.accumulatedText = "";
      break;

    case "text-delta":
      callbacks.onTextDelta(part.delta);
      state.accumulatedText += part.delta;
      break;

    case "text-end":
      flushText(state);
      break;

    // Reasoning (extended thinking) parts. Treated symmetrically with
    // text: deltas accumulate into a single content block on -end.
    // Without this case, reasoning tokens are billed but never appear
    // in `content[]` — turns that produce only reasoning render as
    // empty (the failure mode that started this whole thread).
    // Provider metadata (e.g. Anthropic's thinking signature) is
    // merged across all reasoning-* parts of a block so the block
    // can round-trip on the next iteration's prompt.
    case "reasoning-start":
      state.accumulatedReasoning = "";
      state.reasoningProviderMetadata = part.providerMetadata
        ? { ...part.providerMetadata }
        : undefined;
      break;

    case "reasoning-delta":
      callbacks.onReasoningDelta?.(part.delta);
      state.accumulatedReasoning += part.delta;
      if (part.providerMetadata) {
        state.reasoningProviderMetadata = mergeProviderMetadata(
          state.reasoningProviderMetadata,
          part.providerMetadata,
        );
      }
      break;

    case "reasoning-end":
      flushReasoning(state);
      break;

    // Tool-input parts: surface model-side tool intent before the
    // engine actually dispatches the tool. `-delta` is intentionally
    // not forwarded — per-char SSE traffic for no UI gain (the chat
    // shows tool *intent*, not the JSON forming).
    case "tool-input-start":
      callbacks.onToolInputStart?.(part.id, part.toolName);
      break;

    case "tool-input-delta":
      break;

    case "tool-input-end":
      callbacks.onToolInputEnd?.(part.id);
      break;

    case "tool-call":
      state.content.push(part);
      break;

    case "finish":
      state.usage = part.usage;
      state.finishReason = part.finishReason;
      break;
  }
}

/** Push the buffered text block to content if non-empty, then reset the text buffer. */
function flushText(state: StreamState): void {
  if (state.accumulatedText) {
    state.content.push({ type: "text", text: state.accumulatedText });
  }
  state.accumulatedText = "";
}

/** Push the buffered reasoning block (with any provider metadata) if present, then reset. */
function flushReasoning(state: StreamState): void {
  if (state.accumulatedReasoning || state.reasoningProviderMetadata) {
    state.content.push({
      type: "reasoning",
      text: state.accumulatedReasoning,
      ...(state.reasoningProviderMetadata
        ? { providerMetadata: state.reasoningProviderMetadata }
        : {}),
    });
  }
  state.accumulatedReasoning = "";
  state.reasoningProviderMetadata = undefined;
}

/**
 * Shallow-merge two provider-metadata bags by provider key. Each provider
 * gets its own object spread together; later keys win. The AI SDK only
 * cares about the per-provider sub-object (e.g. `anthropic.signature`),
 * so a deeper merge isn't needed.
 */
function mergeProviderMetadata(
  a: SharedV3ProviderMetadata | undefined,
  b: SharedV3ProviderMetadata,
): SharedV3ProviderMetadata {
  if (!a) return { ...b };
  const out: SharedV3ProviderMetadata = { ...a };
  for (const [provider, meta] of Object.entries(b)) {
    out[provider] = { ...(out[provider] ?? {}), ...(meta ?? {}) };
  }
  return out;
}
