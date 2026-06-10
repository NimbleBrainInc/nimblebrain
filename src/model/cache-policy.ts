import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";

/**
 * Provider-scoped prompt-cache policy.
 *
 * Caching is an Anthropic-specific concern (the `anthropic.cacheControl`
 * provider option, the 4-breakpoint budget, the prefix-match semantics), so it
 * is quarantined here — mirroring how reasoning-replay policy is quarantined in
 * `conversation/window.ts::applyReasoningReplayPolicy`. The engine stays
 * provider-agnostic: it calls `applyCachePolicy(provider, …)` and never knows
 * which breakpoints were placed.
 *
 * ## Why this exists
 *
 * The agent loop appends an assistant turn (+ its tool results) to the message
 * history on every iteration, then re-sends the whole growing prompt. The
 * previous design placed a single cache breakpoint on the *last user message*,
 * which is FIXED for the life of a run (the user speaks once; the model then
 * loops internally). So every iteration's freshly-appended assistant/tool
 * content lived *after* the only breakpoint — uncached — and Anthropic's
 * automatic prefix matching only reaches back ~20 content blocks, far short of
 * a 50–120-iteration run. The result, measured in production: the entire
 * growing prefix was re-WRITTEN to cache every turn (cache-write was ~80% of
 * cost; effective hit rate 14–40%).
 *
 * ## The fix: a rolling step-anchor
 *
 * Between two consecutive model calls the engine appends exactly one *step* —
 * one assistant message plus its tool-result messages. So the message
 * immediately before the most-recent assistant message is precisely the
 * PREVIOUS request's tail. Placing an explicit breakpoint there gives an
 * exact-match cache read of the entire prior prefix (explicit breakpoints match
 * exactly, with no 20-block lookback limit), after which only the new step is
 * written. This converts the per-turn full re-write into a per-turn delta
 * write — the "perfect append-only" behavior, validated against the live
 * Anthropic API (cache-write ↓ ~78% over 7 turns, widening with length).
 *
 * Four breakpoints, within Anthropic's budget of four:
 *   1. tools   — last tool definition (the tools block, position 0). Stable
 *               across most turns, but not frozen: tripped/promoted tools can
 *               change the set mid-run, which busts this breakpoint (a cache
 *               miss on tools + everything after — degraded, never incorrect).
 *   2. system  — the system prompt
 *   3. anchor  — last message of the previous step (= prior request's tail)
 *   4. tail    — the current last message (cached for the NEXT turn to read)
 */

/**
 * 1-hour ephemeral cache control. Agentic runs pause between turns (tool
 * execution, the user reading and replying) for longer than Anthropic's
 * default 5-minute TTL, which would let the prefix lapse and force a full
 * re-write. The 1-hour TTL keeps the prefix warm across those gaps. The 1-hour
 * write rate is higher than 5-minute, but it is paid once per write and is
 * dwarfed by the reads it unlocks across a long run.
 */
export const CACHE_CONTROL_1H: SharedV3ProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
};

export interface CachePolicyInput {
  /** Bare provider id, e.g. "anthropic" (from `getProviderFromModel`). */
  provider: string;
  /** System prompt text (sent as the prompt's leading system message). */
  systemPrompt: string;
  /** Conversation messages (post windowing/replay transforms). */
  messages: LanguageModelV3Message[];
  /** The model's tool definitions for this call. */
  tools: LanguageModelV3FunctionTool[];
}

export interface CachePolicyResult {
  /** Full prompt array (system message + messages) ready for `callModel`. */
  prompt: LanguageModelV3Message[];
  /** Tools, with a cache breakpoint on the last definition where applicable. */
  tools: LanguageModelV3FunctionTool[];
}

/**
 * A provider's caching strategy: given the assembled prompt parts, return the
 * final prompt + tools annotated however that provider's API expects.
 *
 * The platform is multi-model, and providers cache differently — Anthropic uses
 * up to four explicit `cache_control` breakpoints per request; OpenAI caches
 * long prompt prefixes automatically with no per-request markup (so it only
 * needs a stable, append-only prefix, which the rest of the engine already
 * guarantees); Google Gemini uses a separate `cachedContent` resource rather
 * than inline options. Each provider registers a strategy here; the engine
 * stays agnostic.
 */
export type CacheStrategy = (input: CachePolicyInput) => CachePolicyResult;

/** Merge cache control onto a message's existing providerOptions. */
function withCacheControl(message: LanguageModelV3Message): LanguageModelV3Message {
  return {
    ...message,
    providerOptions: { ...message.providerOptions, ...CACHE_CONTROL_1H },
  } as LanguageModelV3Message;
}

/**
 * Index of the rolling step-anchor: the last message of the previous step,
 * i.e. the message immediately before the most-recent assistant message. That
 * position is exactly the prior request's tail, so an explicit breakpoint there
 * yields an exact-match read of the whole prior prefix. Returns -1 when there
 * is no such message (first iteration of a run — no assistant turn yet, or the
 * latest assistant turn is the very first message).
 */
function stepAnchorIndex(messages: LanguageModelV3Message[]): number {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  return lastAssistant > 0 ? lastAssistant - 1 : -1;
}

function systemMessageOf(systemPrompt: string): LanguageModelV3Message {
  return { role: "system" as const, content: systemPrompt } as unknown as LanguageModelV3Message;
}

/**
 * Passthrough strategy: prepend the system message, touch nothing else. Correct
 * for providers whose caching is automatic and prefix-based (e.g. OpenAI) — the
 * append-only prefix the engine already produces is all they need.
 */
const passthroughStrategy: CacheStrategy = ({ systemPrompt, messages, tools }) => ({
  prompt: [systemMessageOf(systemPrompt), ...messages],
  tools,
});

/**
 * Anthropic strategy: place up to four explicit `cache_control` breakpoints —
 * tools (1), system (2), rolling step-anchor (3), tail (4). See the module
 * header for why the step-anchor is the load-bearing one.
 */
const anthropicStrategy: CacheStrategy = ({ systemPrompt, messages, tools }) => {
  // (2) system breakpoint.
  const cachedSystem = withCacheControl(systemMessageOf(systemPrompt));

  // (3) rolling step-anchor + (4) tail. The two indices can coincide when the
  // history is a single message; dedupe so we never double-annotate.
  const tailIdx = messages.length - 1;
  const anchorIdx = stepAnchorIndex(messages);
  const breakpointIdxs = new Set<number>();
  if (tailIdx >= 0) breakpointIdxs.add(tailIdx);
  if (anchorIdx >= 0 && anchorIdx !== tailIdx) breakpointIdxs.add(anchorIdx);
  const cachedMessages = messages.map((m, i) => (breakpointIdxs.has(i) ? withCacheControl(m) : m));

  // (1) tools breakpoint on the last definition — caches the whole tools block
  // (position 0 in Anthropic's tools→system→messages order).
  const cachedTools =
    tools.length === 0
      ? tools
      : tools.map((t, i) =>
          i === tools.length - 1
            ? ({
                ...t,
                providerOptions: { ...t.providerOptions, ...CACHE_CONTROL_1H },
              } as LanguageModelV3FunctionTool)
            : t,
        );

  return { prompt: [cachedSystem, ...cachedMessages], tools: cachedTools };
};

/**
 * Per-provider cache strategies. To add caching for a new provider, register
 * its strategy here — no engine change. Providers without an entry fall back to
 * passthrough (automatic/no caching), which is always safe.
 */
const CACHE_STRATEGIES: Record<string, CacheStrategy> = {
  anthropic: anthropicStrategy,
};

/**
 * Apply the provider's prompt-cache policy, returning the final prompt + tools.
 * The engine calls this once per model call and stays unaware of which (if any)
 * breakpoints were placed.
 */
export function applyCachePolicy(input: CachePolicyInput): CachePolicyResult {
  const strategy = CACHE_STRATEGIES[input.provider] ?? passthroughStrategy;
  return strategy(input);
}
