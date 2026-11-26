/**
 * Where a turn's time went, and a note for the person while the first token
 * is late. Both read only the vendor CLI's event names, counts and short
 * reasons, never a prompt, a tool's arguments or output, or a credential.
 */

import type * as acp from "@agentclientprotocol/sdk/unstable";
import { log } from "../log.ts";
import { redact } from "./failure.ts";
import type { SessionPurpose } from "./types.ts";

/** How long a turn may show nothing before the person is told it is waiting, and how often again. */
export const WAIT_NOTE_MS = 15_000;

/** The longest reason kept for one event. */
const REASON_CHARS = 80;

export interface Timeline {
  /** Records `name` the first time it happens; later ones are ignored. */
  mark(name: string): void;
  /** A retry, an error or another notable event, with a short reason. */
  event(what: string): void;
  /**
   * A retry of the model request: `what` for the log, `attempt` ("attempt 2
   * of 10") for the waiting note, which names the most recent one.
   */
  retry(what: string, attempt: string): void;
  /** The plan's rate-limit window as the CLI last reported it. */
  rateLimit(text: string): void;
  /** The first output a person sees (text, thinking, a tool call): ends the waiting note. */
  output(): void;
  /** Stops the note and logs the turn's one line. */
  end(): void;
}

/**
 * One turn's timeline: seconds from spawn to each of `marks` (`-` for one
 * that never happened), then the events, then the rate limit, logged as one
 * line when the turn ends:
 *
 *     timeline turn claude-code sonnet: spawn 0.0 init 0.3 ... exit 4.1 | events: none | rate_limit: allowed seven_day 0.27
 *
 * For a turn (never an internal run, which no one watches), a note is
 * streamed as a thought every `noteMs` until the first output.
 */
export function startTimeline(opts: {
  backend: string;
  label: string;
  model: string | undefined;
  purpose: SessionPurpose;
  marks: readonly string[];
  emit: (update: acp.SessionUpdate) => void;
  noteMs?: number;
  now?: () => number;
  write?: (line: string) => void;
}): Timeline {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const at = () => (now() - t0) / 1000;
  const marks = new Map<string, number>([["spawn", 0]]);
  const events: string[] = [];
  let retry: string | undefined;
  let rate: string | undefined;
  let output = false;
  let ended = false;
  const noteMs = opts.noteMs ?? WAIT_NOTE_MS;
  const timer =
    opts.purpose === "turn"
      ? setInterval(() => {
          if (output) return;
          const secs = Math.round(at());
          const text = retry
            ? `${opts.label} is retrying the API request (${retry}, ${secs}s so far)…\n`
            : `Waiting for ${opts.label} to start answering (${secs}s)…\n`;
          opts.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
        }, noteMs)
      : undefined;
  timer?.unref?.();
  const stop = () => {
    if (timer) clearInterval(timer);
  };
  return {
    mark(name) {
      if (!marks.has(name)) marks.set(name, at());
    },
    event(what) {
      events.push(`${at().toFixed(1)} ${reason(what)}`);
    },
    retry(what, attempt) {
      retry = attempt;
      events.push(`${at().toFixed(1)} retry ${reason(what)}`);
    },
    rateLimit(text) {
      rate = reason(text);
    },
    output() {
      output = true;
      stop();
    },
    end() {
      if (ended) return;
      ended = true;
      stop();
      const times = ["spawn", ...opts.marks]
        .map((m) => `${m} ${marks.has(m) ? (marks.get(m) ?? 0).toFixed(1) : "-"}`)
        .join(" ");
      const who = `${opts.purpose} ${opts.backend} ${opts.model ?? "default"}`;
      (opts.write ?? log)(
        `timeline ${who}: ${times} | events: ${events.length ? events.join(", ") : "none"} | rate_limit: ${rate ?? "-"}`,
      );
    },
  };
}

/** One line, short, with anything that looks like a credential removed. */
function reason(text: string): string {
  const one = redact(text.replace(/\s+/g, " ").trim());
  return one.length > REASON_CHARS ? `${one.slice(0, REASON_CHARS - 1)}…` : one;
}
