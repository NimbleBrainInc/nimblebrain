/**
 * A model call through the installation's model gateway (`execution.modelGateway`)
 * that the gateway never answered: the connection failed (refused, name not
 * found, reset) or the stream watchdog's first-content deadline passed before
 * any response arrived. The call fails naming the gateway, so an outage of the
 * gateway does not read as a model's stream stalling.
 *
 * The gateway's fetch (`src/runtime/model-gateway-fetch.ts`) marks a call it got
 * no response for, keyed on the call's abort signal; `callModel`
 * (`src/model/stream.ts`) reads the mark for the signal it handed the call. The
 * fetch does not throw the error itself: an abort must stay an abort for the
 * provider client and for a cancelled run, and the provider client rewraps a
 * connection failure it recognizes, so only the end of the call sees the
 * failure as the run will.
 */

const noResponse = new WeakSet<AbortSignal>();

/** Record that the gateway gave the call on `signal` no response. */
export function markGatewayNoResponse(signal: AbortSignal | null | undefined): void {
  if (signal) noResponse.add(signal);
}

/** Whether the gateway gave the call on `signal` no response. */
export function gatewayGaveNoResponse(signal: AbortSignal): boolean {
  return noResponse.has(signal);
}

/**
 * The failure of a call the gateway never answered. The original failure is the
 * `cause`, and its retry verdict (`retryable`, `isRetryable`) is copied, so
 * `withRetry` retries it exactly as it would the original.
 */
export class ModelGatewayNoResponseError extends Error {
  override readonly name = "ModelGatewayNoResponseError";
  readonly retryable: boolean | undefined;
  readonly isRetryable: boolean | undefined;
  constructor(cause: unknown) {
    super(
      `The model gateway didn't respond: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    const fields = (typeof cause === "object" && cause !== null ? cause : {}) as {
      retryable?: unknown;
      isRetryable?: unknown;
    };
    this.retryable = typeof fields.retryable === "boolean" ? fields.retryable : undefined;
    this.isRetryable = typeof fields.isRetryable === "boolean" ? fields.isRetryable : undefined;
  }
}
