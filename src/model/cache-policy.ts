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
 * TTL is tiered by breakpoint stability, because the 1-hour write rate (2x base
 * input) is a 60% premium over the 5-minute rate (1.25x) and only pays off when
 * a cached segment is re-read after a >5-minute gap.
 *
 * - **1-hour** on the STABLE prefix (system + tools): written once per run and
 *   expensive to rebuild, so it's worth keeping warm across a between-runs pause
 *   (a user stepping away for minutes). One write per run — the premium is small.
 * - **5-minute** on the ROLLING history (the step-anchor + tail): rewritten
 *   every turn and always re-read seconds later within the same agentic loop, so
 *   the 1-hour premium buys nothing there. After a >5-minute pause this portion
 *   lapses and the history re-writes at the cheaper 5-minute rate, while the
 *   system+tools prefix stays warm at 1-hour.
 *
 * Net: pay the premium only where it earns its keep. Costing is TTL-aware — the
 * 1h/5m split is captured per call (see `usage/cost.ts`).
 */
export const CACHE_CONTROL_1H: SharedV3ProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
};
export const CACHE_CONTROL_5M: SharedV3ProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
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
  /**
   * Index past which tools are deferred/volatile and must NOT bear the tools
   * cache breakpoint (from the disclosure result's `eagerCount`). The 1h tools
   * breakpoint lands on the last EAGER tool — `tools[eagerToolCount - 1]` — so
   * appending deferred or provider tools after the eager prefix can't bust the
   * cached eager block (or the system + messages after it). Defaults to
   * `tools.length`: with no disclosure the whole array is eager and the
   * breakpoint sits on the last tool, exactly as before.
   */
  eagerToolCount?: number;
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

/** Merge the given cache control onto a message's existing providerOptions. */
function withCacheControl(
  message: LanguageModelV3Message,
  control: SharedV3ProviderOptions,
): LanguageModelV3Message {
  return {
    ...message,
    providerOptions: { ...message.providerOptions, ...control },
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
 * Anthropic strategy: place up to four explicit `cache_control` breakpoints,
 * TTL-tiered by stability — tools (1, 1h) + system (2, 1h) on the stable
 * prefix; rolling step-anchor (3, 5m) + tail (4, 5m) on the churning history.
 * See the module header for the TTL rationale and why the step-anchor is the
 * load-bearing breakpoint.
 */
const anthropicStrategy: CacheStrategy = ({ systemPrompt, messages, tools, eagerToolCount }) => {
  // (2) system breakpoint — stable, 1-hour.
  const cachedSystem = withCacheControl(systemMessageOf(systemPrompt), CACHE_CONTROL_1H);

  // (3) rolling step-anchor + (4) tail — churning, 5-minute. The two indices
  // can coincide when the history is a single message; dedupe so we never
  // double-annotate.
  const tailIdx = messages.length - 1;
  const anchorIdx = stepAnchorIndex(messages);
  const breakpointIdxs = new Set<number>();
  if (tailIdx >= 0) breakpointIdxs.add(tailIdx);
  if (anchorIdx >= 0 && anchorIdx !== tailIdx) breakpointIdxs.add(anchorIdx);
  const cachedMessages = messages.map((m, i) =>
    breakpointIdxs.has(i) ? withCacheControl(m, CACHE_CONTROL_5M) : m,
  );

  // (1) tools breakpoint on the last EAGER tool — caches the eager prefix
  // (position 0 in Anthropic's tools→system→messages order). Stable, 1-hour.
  // Disclosure may append deferred/provider tools after the eager prefix
  // (`tools[eagerToolCount..]`); those are the volatile suffix and must sit
  // AFTER the breakpoint so the churning union can't bust the cached eager
  // block. `eagerToolCount` defaults to `tools.length` — with no disclosure the
  // breakpoint is the last tool, exactly as before. A count of 0 (no eager
  // tools) places no tools breakpoint.
  const eagerBreakpointIdx = (eagerToolCount ?? tools.length) - 1;
  const cachedTools =
    eagerBreakpointIdx < 0
      ? tools
      : tools.map((t, i) =>
          i === eagerBreakpointIdx
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
