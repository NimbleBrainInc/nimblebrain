import { log } from "../observability/log.ts";

/** Retryable HTTP status codes: rate limit (429) and overload (529). */
const RETRYABLE_STATUSES = new Set([429, 529]);

/** Auth errors that should never be retried. */
const AUTH_STATUS = 401;

/** Extract HTTP status from an error object (Anthropic SDK convention). */
function getStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    return (err as { status: number }).status;
  }
  return undefined;
}

/**
 * Returns true if the error is retryable: a retryable HTTP status (429 / 529),
 * or an error that flags itself with `retryable === true`. The marker keeps
 * this generic — callers (e.g. the model-stream stall watchdog) opt in by
 * throwing a `retryable` error, without this module depending on their types.
 */
export function isRetryable(err: unknown): boolean {
  if (
    err !== null &&
    typeof err === "object" &&
    (err as { retryable?: unknown }).retryable === true
  ) {
    return true;
  }
  const status = getStatus(err);
  return status !== undefined && RETRYABLE_STATUSES.has(status);
}

/**
 * Why an error was retried, for the log line: the HTTP status when membership of
 * `RETRYABLE_STATUSES` is what made it retryable, and the error's name
 * otherwise — `isRetryable` also admits anything flagged `retryable` (the
 * model-stream stall watchdog throws one), and that path carries no status.
 *
 * Membership, not presence. `getStatus` is an unchecked cast over a foreign
 * object, so `status` can hold a value of any shape, and the `retryable` branch
 * never constrains it. Interpolating on presence alone would put an unexamined
 * value into a log message — the one part the field redactor does not scan,
 * which is the same reason the provider's error text is left out entirely.
 */
function retryReason(err: unknown): string | number {
  const status = getStatus(err);
  if (status !== undefined && RETRYABLE_STATUSES.has(status)) return status;
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
 * - Retries on 429 (rate limit), 529 (overload), and errors flagged
 *   `retryable` (e.g. a stalled model stream).
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
      const status = getStatus(err);

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
