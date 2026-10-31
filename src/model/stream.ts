import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { isProviderStreamError } from "@ai-sdk/provider-utils";
import { withSpan } from "../observability/index.ts";
import { log } from "../observability/log.ts";
import { registerLiveness, unregisterLiveness } from "./fetch-liveness.ts";
import { gatewayGaveNoResponse, ModelGatewayNoResponseError } from "./gateway-no-response.ts";

/**
 * The watchdog bounds a single model stream in two regimes, because time-to-
 * first-token and inter-token latency have different physics:
 *
 * - **First content** — connect + prefill + first token. Prefill time scales
 *   with input size (a large cold-cache prompt can take many seconds to first
 *   token). This deadline must be generous enough not to trip a live-but-slow
 *   start, yet still bound a connect/first-chunk hang — which on the chat path
 *   has no run wall clock behind it.
 * - **Idle (inter-part)** — once output is flowing, a gap this long with no
 *   activity is a genuine stall. Reset on every part, so a healthy long
 *   generation (extended thinking, large output) never trips it.
 *
 * Crucially, the deadline is re-armed on *transport liveness*, not just decoded
 * parts: the fetch tap in `fetch-liveness.ts` pokes the watchdog on every byte
 * the provider sends, including the keep-alive `ping` frames the AI SDK swallows
 * before they become parts. So the idle deadline bounds true socket silence
 * (nothing at all coming back), not merely the gap between decoded tokens — a
 * healthy-but-slow large-context stream keeps the socket warm with pings and
 * never trips, while a dead connection still does. That decoupling is why the
 * idle deadline can stay comfortably above the observed inter-token gap: it is
 * now a "the server has gone quiet on the wire" threshold.
 *
 * Both sit below a typical run budget so a stall is caught (and the pre-content
 * case retried) with room to spare, instead of the whole run blocking on one
 * hung call until `maxRunDurationMs`.
 */
export const MODEL_STREAM_FIRST_CONTENT_TIMEOUT_MS = 90_000;
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 75_000;

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

/**
 * Thrown when a model stream carries an `error` part: the provider reported a
 * failure after the HTTP response opened (e.g. Anthropic's SSE
 * `overloaded_error`), or the stream broke and never finished cleanly.
 *
 * `statusCode` and `isRetryable` are the provider's own verdict, copied so
 * `withRetry` classifies this error as it would the same failure thrown by
 * `doStream`. `retryable: false` is set only once output reached the client,
 * the same rule as {@link ModelStreamStallError}: re-issuing would re-stream
 * deltas. The provider's error is kept as `cause`.
 */
export class ModelStreamError extends Error {
  readonly statusCode: number | undefined;
  readonly isRetryable: boolean | undefined;
  readonly retryable: boolean | undefined;
  constructor(error: unknown, opts: { sawOutput: boolean }) {
    super(streamErrorMessage(error), { cause: error });
    this.name = "ModelStreamError";
    const fields = (typeof error === "object" && error !== null ? error : {}) as {
      statusCode?: unknown;
      isRetryable?: unknown;
    };
    this.statusCode = typeof fields.statusCode === "number" ? fields.statusCode : undefined;
    this.isRetryable = typeof fields.isRetryable === "boolean" ? fields.isRetryable : undefined;
    this.retryable = opts.sawOutput ? false : undefined;
  }
}

function streamErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const { message } = error as { message?: unknown };
    if (typeof message === "string" && message) return message;
  }
  return "Model stream reported an error";
}

/**
 * `finishReason.raw` recorded when a stream ends without a `finish` part. The
 * unified value is then "other", the same bucket the AI SDK uses for provider
 * stops it does not recognize, so this marker is what tells "the provider sent
 * no finish" apart from "the provider sent a stop reason we could not map".
 * Provider raw values are provider enum strings (e.g. Anthropic `end_turn`),
 * never this one.
 */
export const NO_FINISH_PART_RAW = "no_finish_part";

export interface StreamResult {
  content: LanguageModelV4Content[];
  usage: LanguageModelV4Usage;
  finishReason: LanguageModelV4FinishReason;
  /**
   * Time-to-first-token in milliseconds: from stream start (pre-`doStream`) to
   * the first output part (text / reasoning / tool-input). Approximates connect
   * + provider queue + prefill — the slice of round-trip latency a long decode
   * hides. `undefined` when the call produced no output part (empty completion).
   */
  ttftMs?: number;
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
  content: LanguageModelV4Content[];
  usage: LanguageModelV4Usage;
  finishReason: LanguageModelV4FinishReason;
  accumulatedText: string;
  accumulatedReasoning: string;
  // Reasoning provider metadata accumulator. Anthropic transports the
  // thinking-block signature as a separate `signature_delta` event that
  // the AI SDK forwards as a `reasoning-delta` with empty text and
  // `providerMetadata.anthropic.signature`. Without persisting that
  // signature, the next iteration's prompt fails to round-trip the
  // reasoning block — the AI SDK provider drops it as "unsupported
  // reasoning metadata" and Anthropic 400s the request.
  reasoningProviderMetadata: SharedV4ProviderMetadata | undefined;
  // True once a `finish` part arrived; until then `finishReason` is our default.
  sawFinish: boolean;
  // The first `error` part that was not a provider-reported failure: a chunk
  // that failed to parse, or a provider's malformed-stream error. Providers
  // keep streaming after one, so it fails the call only if the stream then
  // ends without a clean finish (see `deferredStreamError`).
  streamError: unknown;
}

/**
 * Trace one model call as an `llm.call` span nested under the active
 * `agent.turn`. Attributes are operational only — model id, provider, token
 * counts, finish reason (unified and raw). Prompt and completion content are
 * NEVER recorded.
 */
export async function callModel(
  model: LanguageModelV4,
  options: LanguageModelV4CallOptions,
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
        // The provider's own stop reason (an enum string such as `end_turn`),
        // or NO_FINISH_PART_RAW. Several distinct provider stops share the
        // unified "other"; this names which one it was.
        ...(result.finishReason.raw ? { "llm.finish_reason_raw": result.finishReason.raw } : {}),
        ...(result.ttftMs !== undefined ? { "llm.ttft_ms": result.ttftMs } : {}),
      });
      return result;
    },
  );
}

async function callModelInner(
  model: LanguageModelV4,
  options: LanguageModelV4CallOptions,
  onTextDelta: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  /**
   * Called once when the model begins emitting a tool-call block, with
   * the tool name already known. Lets the engine surface "Calling X…"
   * during the dark gap where the model is streaming a large tool
   * input — `tool.start` only fires after `callModel` returns.
   *
   * Provider-agnostic: AI SDK V4 normalizes `tool-input-start` across
   * Anthropic / OpenAI / Google. Providers that never emit it simply
   * skip the callback (engine falls back to `tool.start`-only signals).
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
    // V4-defined catch-all for unclassified stops; the raw marker keeps this
    // case distinguishable from a provider stop reason that maps to "other".
    finishReason: { unified: "other", raw: NO_FINISH_PART_RAW },
    accumulatedText: "",
    accumulatedReasoning: "",
    reasoningProviderMetadata: undefined,
    sawFinish: false,
    streamError: undefined,
  };
  const callbacks: StreamCallbacks = {
    onTextDelta,
    onReasoningDelta,
    onToolInputStart,
    onToolInputEnd,
  };

  const watchdog = createStreamWatchdog(options.abortSignal, { firstContentMs, idleMs });
  // The fetch tap (fetch-liveness.ts) pokes this on every provider byte, keyed
  // on the same signal we hand doStream — so swallowed `ping` keep-alives re-arm
  // the deadline in the current regime. `arm()` only; a keep-alive must not flip
  // `sawOutput` (that would corrupt TTFT and a later stall's retryability).
  registerLiveness(watchdog.signal, () => watchdog.arm());
  try {
    // Arm BEFORE doStream: for some providers (e.g. Anthropic) `doStream` does
    // not resolve until the first stream event arrives, so a connect / first-
    // chunk hang lives entirely inside this await. On the chat path there is no
    // run wall clock to catch it, so the first-content deadline must.
    watchdog.arm();
    const { stream } = await model.doStream({ ...options, abortSignal: watchdog.signal });
    await pumpStream(stream, state, callbacks, watchdog);
    const deferred = deferredStreamError(state, watchdog.sawOutput);
    if (deferred) throw deferred;
  } catch (err) {
    // A genuine run-level abort (external signal) is not a stall: propagate it.
    if (options.abortSignal?.aborted) throw err;
    // Our watchdog fired (the stream stalled) → surface a stall. Retryable only
    // before output began.
    const failure = watchdog.stalled
      ? new ModelStreamStallError(watchdog.sawOutput ? idleMs : firstContentMs, {
          retryable: !watchdog.sawOutput,
        })
      : err;
    // The installation's model gateway never answered the call: name it.
    throw gatewayGaveNoResponse(watchdog.signal)
      ? new ModelGatewayNoResponseError(failure)
      : failure;
  } finally {
    unregisterLiveness(watchdog.signal);
    watchdog.dispose();
  }

  // Drain any in-flight accumulators that didn't see their -end part.
  flushText(state);
  flushReasoning(state);

  return {
    content: state.content,
    usage: state.usage,
    finishReason: state.finishReason,
    // Reads the watchdog's first-output timestamp (undefined if no output part
    // arrived). Measured on THIS attempt's stream, so on a retry it reflects the
    // successful call — distinct from the engine's `llmMs`, which wraps the whole
    // recovery (failed attempts + backoff).
    ttftMs: watchdog.ttftMs,
  };
}

/**
 * Read the stream to completion, folding each part into `state` and re-arming
 * the watchdog on every part (switching to the idle regime once output begins).
 * Returns when the stream ends; rejects if a read is aborted (stall or cancel)
 * or the provider reports an error mid-stream.
 */
async function pumpStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
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
      if (part.type === "error") {
        recordStreamError(state, part.error, watchdog.sawOutput);
        continue;
      }
      applyPart(state, part, callbacks);
    }
  } catch (err) {
    // Close the provider's response body: releasing the lock alone leaves it
    // open. Not awaited, so a body that never settles cannot hold the throw.
    reader.cancel(err).catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Handle an `error` part. A provider-reported failure (rate limit, overload,
 * server error; marked by the SDK's `createProviderStreamError`) fails the call
 * now. Anything else is a chunk that did not parse or a malformed stream, which
 * providers follow with more parts and often a valid finish, so it is recorded
 * and only fails the call if the stream ends without one. The log line names
 * the error only: its message can quote the chunk, which is model output.
 */
function recordStreamError(state: StreamState, error: unknown, sawOutput: boolean): void {
  if (isProviderStreamError(error)) throw new ModelStreamError(error, { sawOutput });
  log.warn(`[model] stream error part: ${error instanceof Error ? error.name : typeof error}`);
  if (state.streamError === undefined) state.streamError = error;
}

/**
 * The error to throw once the stream has ended, if any. A recorded error part
 * fails the call when the stream did not finish cleanly: no `finish` part, a
 * finish of `error`, or the SDK's default finish (`other` with no raw reason,
 * which a provider sends when it never saw a stop reason).
 *
 * Only before output. After output the turn returns as it ended, keeping its
 * content and usage; a non-retryable throw would discard both and gain nothing.
 */
function deferredStreamError(state: StreamState, sawOutput: boolean): ModelStreamError | undefined {
  if (state.streamError === undefined || sawOutput) return undefined;
  const { unified, raw } = state.finishReason;
  const clean =
    state.sawFinish && unified !== "error" && !(unified === "other" && raw === undefined);
  return clean ? undefined : new ModelStreamError(state.streamError, { sawOutput });
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
  /**
   * Time-to-first-token in ms: watchdog creation (≈ stream start, pre-`doStream`)
   * to the first output part. `undefined` until the first output part arrives —
   * and stays `undefined` for a completion that emits no output part (empty
   * result, or a provider that streams a tool-call with no `tool-input-start`).
   */
  readonly ttftMs: number | undefined;
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
  // Captured at creation (≈ the pre-`doStream` moment; the arm() and doStream
  // calls that follow are synchronous set-up) so the watchdog can report
  // time-to-first-token as `firstOutputAt - createdAt`.
  const createdAt = performance.now();
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let sawOutput = false;
  let firstOutputAt: number | undefined;
  let stalled = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    signal: controller.signal,
    get sawOutput() {
      return sawOutput;
    },
    get ttftMs() {
      return firstOutputAt === undefined ? undefined : Math.round(firstOutputAt - createdAt);
    },
    get stalled() {
      return stalled;
    },
    arm(): void {
      // A transport-liveness poke can land after the stream is consumed and the
      // watchdog disposed; ignore it so no zombie timer is armed post-dispose.
      if (disposed) return;
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
      // First output part only — this timestamp is the TTFT endpoint. `arm()`
      // re-runs every part, but this must not: recording the LAST output part
      // would measure end-of-decode, inverting the metric.
      if (firstOutputAt === undefined) firstOutputAt = performance.now();
      sawOutput = true;
    },
    dispose(): void {
      disposed = true;
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
function isOutputPart(part: LanguageModelV4StreamPart): boolean {
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
  part: LanguageModelV4StreamPart,
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
      state.sawFinish = true;
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
  a: SharedV4ProviderMetadata | undefined,
  b: SharedV4ProviderMetadata,
): SharedV4ProviderMetadata {
  if (!a) return { ...b };
  const out: SharedV4ProviderMetadata = { ...a };
  for (const [provider, meta] of Object.entries(b)) {
    out[provider] = { ...(out[provider] ?? {}), ...(meta ?? {}) };
  }
  return out;
}
