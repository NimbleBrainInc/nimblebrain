/**
 * Transport-liveness tap for provider model streams.
 *
 * The model-stream watchdog (`stream.ts`) re-arms only on decoded
 * `LanguageModelV3StreamPart`s. But a provider keeps a slow generation alive
 * with keep-alive frames the AI SDK swallows before they ever become parts:
 * Anthropic emits periodic `ping` events, and `@ai-sdk/anthropic` drops them
 * in its SSE transform (`case "ping": return`). So a healthy-but-slow stream —
 * large-context prefill, extended thinking, long inter-block gaps at a big
 * prompt — looks silent at the part layer and trips the idle deadline as a
 * fatal, non-retryable stall even though the socket is alive and working.
 *
 * This measures liveness at the transport instead of the decoder: a `fetch`
 * wrapper tees the response body and pokes a per-call callback on every byte
 * chunk, including the swallowed keep-alives. The watchdog then re-arms on "the
 * socket is still delivering bytes," which is what a stall actually negates. A
 * genuinely dead socket (no bytes, no keep-alives) still trips.
 *
 * Correlation is keyed on the request's `AbortSignal`. Each model call hands
 * `doStream` the watchdog's unique `signal` (`stream.ts`), the AI SDK forwards
 * it verbatim into `fetch`'s `init.signal`, and the caller registers a poke
 * against that same signal for the duration of the call. Keying a `WeakMap` on
 * the signal is deterministic under concurrent streams (each call owns a
 * distinct signal, so there is no shared-ref race) and self-cleaning — an entry
 * is collected with its signal — though the caller also unregisters eagerly
 * when the stream is done.
 */

type LivenessPoke = () => void;

/**
 * The `fetch` shape the AI SDK providers accept and call — the standard call
 * signature only. Deliberately narrower than Bun's `typeof fetch` (which also
 * carries a `preconnect` method), matching `createAnthropic`'s `fetch` option.
 */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const pokesBySignal = new WeakMap<AbortSignal, LivenessPoke>();

/** Register a per-call liveness poke, keyed on the model call's abort signal. */
export function registerLiveness(signal: AbortSignal, poke: LivenessPoke): void {
  pokesBySignal.set(signal, poke);
}

/** Drop a call's liveness poke once its stream is fully consumed or aborted. */
export function unregisterLiveness(signal: AbortSignal): void {
  pokesBySignal.delete(signal);
}

/**
 * Wrap a `fetch` so every byte chunk of a streamed response body pokes the
 * liveness callback registered for that request's signal. A request with no
 * registered poke, and a response with no body (e.g. 204), pass through
 * untouched. The tee is a passthrough `TransformStream`: it forwards each chunk
 * unchanged and propagates the source's completion / abort / error, so
 * cancellation and error semantics are unaffected.
 */
export function wrapFetchWithLiveness(baseFetch: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const signal = init?.signal ?? undefined;
    const poke = signal ? pokesBySignal.get(signal) : undefined;
    if (!poke || !response.body) return response;
    const tapped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          poke();
          controller.enqueue(chunk);
        },
      }),
    );
    // Reuse the original response's status / statusText / headers; only the
    // body is re-teed through the liveness transform.
    return new Response(tapped, response);
  };
}
