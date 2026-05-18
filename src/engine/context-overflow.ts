/**
 * Detect provider-reported "the prompt exceeds the model's context window"
 * errors so the engine can react with a budget retrim + retry rather than
 * surfacing the raw error to the caller.
 *
 * No provider has a stable, machine-readable error code for this condition
 * — they all surface it as a 400 with a free-text message. We match
 * conservatively on the union of phrasings the major providers use today
 * (Anthropic, OpenAI, Google, Vercel AI SDK pass-throughs) and fall back
 * to throwing the original error unchanged when we're unsure.
 */

interface ErrorLike {
  status?: number;
  statusCode?: number;
  message?: unknown;
  // Vercel AI SDK wraps provider errors and sometimes nests them.
  cause?: unknown;
  data?: unknown;
  responseBody?: unknown;
}

function getStatus(err: ErrorLike): number | undefined {
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  return undefined;
}

function getMessages(err: ErrorLike): string[] {
  const messages: string[] = [];
  if (typeof err.message === "string") messages.push(err.message);
  if (typeof err.responseBody === "string") messages.push(err.responseBody);
  if (err.data && typeof err.data === "object") {
    messages.push(JSON.stringify(err.data));
  }
  if (err.cause && typeof err.cause === "object") {
    const inner = getMessages(err.cause as ErrorLike);
    messages.push(...inner);
  }
  return messages;
}

/**
 * Phrases observed in context-overflow errors across providers. Matched
 * case-insensitively against the error message and any nested response
 * body. Each phrase is on its own to keep the union explicit; adding a
 * new provider phrasing is a one-line change here.
 */
const OVERFLOW_PHRASES: readonly string[] = [
  // Anthropic: `prompt is too long: 1257504 tokens > 1000000 maximum`
  "prompt is too long",
  // OpenAI: `This model's maximum context length is N tokens. However, your messages resulted in M tokens.`
  "maximum context length",
  // OpenAI alt: `context length exceeded`
  "context length exceeded",
  // Google Gemini: `The input token count exceeds the maximum number of tokens allowed`
  "input token count exceeds",
  // Anthropic / generic: `tokens > <N> maximum`
  "tokens >",
  // Fallback that catches several providers' shared phrasing
  "exceeds the maximum",
];

/**
 * Returns true if the error looks like a provider-reported context-window
 * overflow. Conservative — false negatives are OK (engine surfaces the
 * original error) but false positives would cause us to retry-and-retrim
 * on errors that retrimming can't fix.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const errLike = err as ErrorLike;
  const status = getStatus(errLike);
  // Every observed overflow error is a 400 (invalid_request_error). Status
  // is not strictly required — when missing we still match on the message
  // — but a non-4xx status almost certainly means something else (network,
  // 5xx, etc.) and we don't want to retrim on those.
  if (status !== undefined && status !== 400) return false;
  const messages = getMessages(errLike).map((m) => m.toLowerCase());
  return messages.some((m) => OVERFLOW_PHRASES.some((p) => m.includes(p)));
}
