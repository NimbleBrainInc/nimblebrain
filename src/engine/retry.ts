import { log } from "../observability/log.ts";
import { providerStatus } from "./provider-error.ts";

/**
 * Transient HTTP statuses: request timeout (408), rate limit (429), server
 * error and overload (500, 502, 503, 504), and Anthropic's overload (529).
 * The fallback for an error that does not state its own retryability.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Auth errors that should never be retried. */
const AUTH_STATUS = 401;

/** Read a boolean field off a foreign error object, or `undefined`. */
function booleanField(err: object, key: "retryable" | "isRetryable"): boolean | undefined {
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Returns true if the error is retryable. The first source that answers wins:
 *
 * 1. Our own `retryable` marker. Callers opt in or out without this module
 *    depending on their types: the model-stream stall watchdog throws
 *    `retryable: false` once output reached the client, and that must hold
 *    whatever the underlying status says.
 * 2. The provider's `isRetryable`. The AI SDK's `APICallError` always sets it
 *    (from the status, or the provider's own verdict, such as Anthropic's
 *    `overloaded_error` or OpenAI's non-retryable `insufficient_quota`), and it
 *    covers a network failure, which has no status at all.
 * 3. The HTTP status (`status` or `statusCode`) in `RETRYABLE_STATUSES`.
 */
export function isRetryable(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const own = booleanField(err, "retryable");
  if (own !== undefined) return own;
  const provider = booleanField(err, "isRetryable");
  if (provider !== undefined) return provider;
  const status = providerStatus(err);
  return status !== undefined && RETRYABLE_STATUSES.has(status);
}

/**
 * Why an error was retried, for the log line: the HTTP status when the error
 * carries a valid one, and the error's name otherwise (a stalled stream or a
 * network failure carries no status).
 *
 * A range check, not presence. `providerStatus` reads a foreign object, and
 * only a plausible HTTP code goes into the message: the message is the one
 * part of a log line the field redactor does not scan, which is the same
 * reason the provider's error text is left out entirely.
 */
function retryReason(err: unknown): string | number {
  const status = providerStatus(err);
  if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
    return status;
  }
  return err instanceof Error ? err.name : "unknown";
}

/**
 * Sleep that resolves after `ms` or rejects when `signal` aborts —
 * whichever fires first. Used by `withRetry` so a cancel during the
 * backoff window doesn't have to wait the full delay (up to ~8.5s on
 * attempt 3) for the signal to bite. Pre-aborted signal rejects
 * synchronously without arming a timer.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const reasonError = (): Error =>
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted.", "AbortError");
    if (signal?.aborted) {
      reject(reasonError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(reasonError());
      },
      { once: true },
    );
  });
}

/**
 * Retry wrapper with exponential backoff and jitter.
 *
 * - Retries what `isRetryable` admits: a transient provider error (rate
 *   limit, overload, 5xx, network failure) or an error flagged `retryable`
 *   (e.g. a stalled model stream).
 * - Fails immediately on 401 (auth) with a clear message.
 * - Fails immediately on all other errors.
 * - Backoff: baseDelay * 2^attempt + random(0, 500ms).
 * - Logs one `warn` per retried attempt (attempt, reason, backoff). A retry
 *   that eventually succeeds is not an error and moves no counter, so this
 *   line is the only record that it happened.
 * - Optional `signal` interrupts the backoff sleep so a cancel during
 *   backoff bites within the abort tick instead of after the full
 *   delay. The signal also propagates into `fn()` calls if those
 *   honor it (the engine threads `config.signal` to AI SDK
 *   `doStream({ abortSignal })`).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = providerStatus(err);

      if (status === AUTH_STATUS) {
        throw new Error(`Authentication failed (401). Check your API key.`, { cause: err });
      }

      if (!isRetryable(err) || attempt >= maxRetries) {
        throw err;
      }

      const delay = baseDelayMs * 2 ** attempt + Math.random() * 500;
      // A retried attempt is otherwise invisible. It is not a terminal failure,
      // so no error counter moves; TTFT is measured on whichever attempt
      // succeeds, so it stays clean; and only the caller's elapsed-time
      // measurement carries any trace of it. Without this line the condition can
      // only be *inferred* — from elapsed time that output-token generation does
      // not account for — and never attributed to a cause. `retryReason` above
      // explains what goes in the line and what deliberately does not.
      log.warn(
        `[engine] retry attempt=${attempt + 1}/${maxRetries} ` +
          `reason=${retryReason(err)} delayMs=${Math.round(delay)}`,
      );
      await abortableSleep(delay, signal);
    }
  }
}
