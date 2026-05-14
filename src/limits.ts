// --- Engine Hard Caps ---

/** Absolute ceiling on agentic iterations. Not configurable. */
export const MAX_ITERATIONS = 50;

/** Maximum characters in a tool result before truncation for the LLM. */
export const MAX_TOOL_RESULT_CHARS = 50_000;

// --- Runtime Defaults ---

export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_MAX_INPUT_TOKENS = 500_000;
/**
 * Last-resort `maxOutputTokens` when the requested model isn't in the
 * synced catalog. Conservative because the unknown-model case usually
 * means a typo or a freshly-released model — sized to fit Haiku-class
 * models without surprising anyone. Real models go through the catalog.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
/**
 * Cap on the number of tools the model sees in any single turn. Enforced
 * at two lifecycle points against the same invariant:
 *   1. `surfaceTools` (run start): workspaces with ≤ this many installed
 *      tools get Tier-1 (all direct); above it, Tier-2 (system tools only,
 *      app tools discoverable via nb__search).
 *   2. Engine `addTool` (in-run): when an agent-promoted addition would
 *      push past this cap, the least-recently-used agent-promoted tool
 *      is evicted. Initial tools passed to `engine.run()` are exempt —
 *      they're operator-opted-in, not agent-promoted.
 */
export const DEFAULT_MAX_DIRECT_TOOLS = 30;

// --- Delegation ---

export const DEFAULT_CHILD_ITERATIONS = 5;
export const MAX_CHILD_ITERATIONS = 10;
