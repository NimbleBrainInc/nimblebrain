import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";

/**
 * Provider-scoped tool-disclosure policy — the sibling of `cache-policy.ts`.
 *
 * Tool definitions sit at the head of the request (the prompt-cache hierarchy is
 * tools → system → messages), so the active tool set must be append-only: a
 * provider may surface MORE tools without rewriting the cached prefix, but must
 * never reorder or drop the stable eager set mid-conversation. This module
 * decides, per provider, WHICH tools are sent and where the eager (cacheable)
 * prefix ends; `cache-policy.ts` then decides WHERE the breakpoints land. The
 * two compose through a single scalar — `eagerCount` — and neither reads the
 * other's internals: disclosure runs first and returns `{ tools, eagerCount }`
 * (eager tools first, volatile suffix after); cache-policy places the tools
 * breakpoint on `tools[eagerCount - 1]`.
 *
 * Today every provider uses the passthrough strategy: send the eager (direct)
 * set and disclose nothing extra. Discovery happens out-of-band — `nb__search`
 * returns matches as data and the model activates a tool on commit via
 * `nb__manage_tools` — which is provider-agnostic and append-only-safe. A later
 * slice adds an Anthropic strategy that registers the cross-workspace union as
 * deferred (`defer_loading`) plus a tool-search tool, so discovery never touches
 * the cached prefix; that strategy will widen `tools` to include provider tools.
 */

export interface ToolDisclosureInput {
  /** Bare provider id, e.g. "anthropic" (from `getProviderFromModel`). */
  provider: string;
  /** The eager, callable-now tool set (the engine's active `modelTools`). */
  directTools: LanguageModelV3FunctionTool[];
  /** The discoverable corpus not in the active set (eligibility-filtered). */
  deferredTools: LanguageModelV3FunctionTool[];
}

export interface ToolDisclosureResult {
  /**
   * Final tools array for the model call, ordered eager-first: the first
   * `eagerCount` entries are the stable, cacheable prefix; anything after is the
   * volatile suffix (deferred / provider tools) and must NOT bear the tools
   * cache breakpoint. (A later slice widens this to include provider tools.)
   */
  tools: LanguageModelV3FunctionTool[];
  /** Boundary between the cacheable eager prefix and the volatile suffix. */
  eagerCount: number;
}

export type ToolDisclosureStrategy = (input: ToolDisclosureInput) => ToolDisclosureResult;

/**
 * Passthrough: send only the eager set; disclose nothing extra. Correct for
 * every provider today and the permanent fallback — discovery is handled by
 * `nb__search`-as-data + commit-time `nb__manage_tools`, which is
 * provider-agnostic and append-only-safe.
 */
const passthroughDisclosure: ToolDisclosureStrategy = ({ directTools }) => ({
  tools: directTools,
  eagerCount: directTools.length,
});

/**
 * Per-provider disclosure strategies. Empty today (all providers passthrough);
 * a provider registers here to disclose more than the eager set. Mirrors
 * `cache-policy.ts`'s `CACHE_STRATEGIES`.
 */
const TOOL_DISCLOSURE_STRATEGIES: Record<string, ToolDisclosureStrategy> = {};

/**
 * Apply the provider's tool-disclosure policy. The engine calls this once per
 * model call, then feeds the result's `tools` + `eagerCount` into
 * `applyCachePolicy`. Providers without an entry fall back to passthrough.
 */
export function applyToolDisclosure(input: ToolDisclosureInput): ToolDisclosureResult {
  const strategy = TOOL_DISCLOSURE_STRATEGIES[input.provider] ?? passthroughDisclosure;
  return strategy(input);
}
