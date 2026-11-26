/**
 * Why a turn failed, in words a person acts on. The worker sends it to the
 * runtime in the `session/prompt` error's data (`FAILURE_META_KEY`); the
 * runtime shows `message` in the chat as written and reports
 * `agent_<code>`, so each message names its fix.
 *
 * Classified from what the CLIs actually print. Claude Code's stream-json
 * marks an assistant message with `error` (`authentication_failed`,
 * `rate_limit`, `billing_error`, …) and ends with an `is_error` result whose
 * text is the reason ("Not logged in · Please run /login"). `codex exec
 * --json` ends a failed turn with `turn.failed` carrying the API's text
 * ("unexpected status 401 Unauthorized: …", or its usage-limit text).
 */

/** The `session/prompt` error data key the runtime reads. */
export const FAILURE_META_KEY = "nimblebrain-subscription/failure";

export type FailureCode = "signed_out" | "plan_limit" | "api_key" | "cli_missing" | "cli_failed";

/** A turn that failed for a reason the person can act on. */
export class TurnFailed extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type Vendor = "claude" | "codex";

const LABELS: Record<Vendor, string> = { claude: "Claude Code", codex: "Codex" };

const SIGNED_OUT: Record<Vendor, string> = {
  claude:
    "Claude Code is signed out. Run `claude /login` in a terminal, then send your message again.",
  codex:
    "Codex is signed out. Run `codex login` in a terminal and choose Sign in with ChatGPT, then send your message again.",
};

const INSTALL: Record<Vendor, string> = {
  claude:
    "Claude Code is not installed where the agent worker looks for it. Install it (https://claude.com/claude-code), sign in, then run `npx nimblebrain use claude` and send your message again.",
  codex:
    "Codex is not installed where the agent worker looks for it. Install it with `npm i -g @openai/codex`, run `codex login`, then run `npx nimblebrain use codex` and send your message again.",
};

/** A sign-in that is gone or expired, in either CLI's words. */
const SIGNED_OUT_TEXT =
  /not logged in|please run \/login|\/login|oauth token|token (has )?expired|invalid api key|authentication_failed|\b401\b|unauthorized|codex login|refresh token/i;
/** A plan's usage limit, in either CLI's words. */
const LIMIT_TEXT = /usage limit|limit reached|hit your limit|limit will reset|rate_limit_exceeded/i;

/**
 * The failure a CLI's own words describe: signed out, at the plan's limit,
 * or else `cli_failed`, with its last line and where the log is.
 * `apiError` is Claude Code's `error` field, which wins over the text.
 */
export function classifyFailure(
  vendor: Vendor,
  text: string,
  opts: { apiError?: string; exitCode?: number | null; log?: string } = {},
): TurnFailed {
  const { apiError } = opts;
  if (apiError === "authentication_failed" || (!apiError && SIGNED_OUT_TEXT.test(text)))
    return new TurnFailed("signed_out", SIGNED_OUT[vendor]);
  if (apiError === "rate_limit" || apiError === "billing_error" || LIMIT_TEXT.test(text))
    return new TurnFailed("plan_limit", limitMessage(vendor, text));
  return new TurnFailed("cli_failed", failedMessage(vendor, text, opts));
}

/** The CLI could not be started: not installed, or not on the worker's PATH. */
export function cliMissing(vendor: Vendor): TurnFailed {
  return new TurnFailed("cli_missing", INSTALL[vendor]);
}

function limitMessage(vendor: Vendor, text: string): string {
  const plan = vendor === "claude" ? "Your Claude plan" : "Your ChatGPT plan";
  const reset = resetOf(text);
  return `${plan} has reached its usage limit${reset ? ` (${reset})` : ""}. Send your message again once it resets, or run \`npx nimblebrain use api\` in a terminal to use an API key instead.`;
}

/**
 * When the limit resets, in the CLI's own words: Claude Code's "resets 3pm
 * (Pacific/Honolulu)" or its older `|<epoch seconds>`, Codex's "try again in
 * 2 hours" or "try again at 3:05 PM".
 */
export function resetOf(text: string): string | undefined {
  const epoch = text.match(/limit reached\|(\d{10})\b/i)?.[1];
  if (epoch) return `it resets ${new Date(Number(epoch) * 1000).toLocaleString()}`;
  const resets = text.match(/\bresets?\s+((?:at\s+)?[^·\n.!]{1,60})/i)?.[1]?.trim();
  if (resets) return `it resets ${resets}`;
  const again = text.match(/try again (in|at) ([^\n.!]{1,60})/i);
  return again ? `try again ${again[1]} ${again[2]?.trim()}` : undefined;
}

function failedMessage(
  vendor: Vendor,
  text: string,
  opts: { exitCode?: number | null; log?: string },
): string {
  const exited = opts.exitCode === undefined ? "stopped" : `exited (${opts.exitCode ?? "signal"})`;
  const last = lastLine(text);
  const where = opts.log ? `Check ${opts.log}` : "Check the agent worker's log";
  return `${LABELS[vendor]} ${exited} without finishing the turn${last ? `: ${last}` : ""}. ${where} for more, then send your message again.`;
}

/**
 * The text's last non-empty line, short, with anything that looks like a
 * credential removed: the message is shown in chat and kept in the log.
 */
export function lastLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  return redact(line).slice(0, 240);
}

export function redact(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\b[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=\S+/g, "$1=[redacted]")
    .replace(/\b(sk|sess|rt|pk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)*/g, "[redacted]");
}
