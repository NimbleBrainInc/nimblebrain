/**
 * A run's time limit at the run-start door, and the signal that enforces it.
 *
 * A run that carries a per-run model credential is bounded by the credential's
 * lifetime. One with a limit of its own (a task, whose executor enforces it)
 * mints its credential to that limit. One without (a chat turn) is held here to
 * the installation's longest run, and ends with {@link RunDeadlineExceededError}
 * rather than losing model access mid-turn when its credential expires. Every
 * other run keeps its caller's signal and gets no limit from the door.
 */

import { RunDeadlineExceededError } from "./errors.ts";

export interface RunDeadline {
  /** The signal the run executes under. */
  signal: AbortSignal | undefined;
  /** The run's limit, when it has one: what its model credential is minted to. */
  limitMs: number | undefined;
  /** Stops the door's own timer, if it set one. Call as the run ends. */
  clear(): void;
}

export function runDeadline(opts: {
  /** The caller's cancellation. */
  signal: AbortSignal | undefined;
  /** The run's own limit (`RunBudget.maxRunDurationMs`), enforced by its caller. */
  ownLimitMs: number | undefined;
  /** Whether the run carries a per-run model credential. */
  credentialed: boolean;
  /** The installation's longest run (`tasks.maxRunDurationMs`, resolved). */
  ceilingMs: number;
  /** The agent runtime's id, named in the error. */
  runtimeId: string;
}): RunDeadline {
  const { signal, ownLimitMs, credentialed, ceilingMs, runtimeId } = opts;
  if (!credentialed || ownLimitMs !== undefined) {
    return { signal, limitMs: ownLimitMs, clear: () => {} };
  }
  const expiry = new AbortController();
  const timer = setTimeout(
    () => expiry.abort(new RunDeadlineExceededError(runtimeId, ceilingMs)),
    ceilingMs,
  );
  return {
    signal: signal ? AbortSignal.any([signal, expiry.signal]) : expiry.signal,
    limitMs: ceilingMs,
    clear: () => clearTimeout(timer),
  };
}
