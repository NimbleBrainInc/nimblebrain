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
 * Where `surfaceTools` switches tiers at run start: a workspace with at most
 * this many installed tools gets Tier-1 (every tool direct); above it, Tier-2
 * (system tools direct, app tools discoverable via nb__search and promoted with
 * nb__manage_tools).
 */
export const DEFAULT_MAX_DIRECT_TOOLS = 30;

/**
 * How many tools the agent may promote with nb__manage_tools in one run. The
 * tools a run starts with are not counted. A promotion past it is refused with
 * `cap_reached`, so the model releases one to make room; nothing is evicted.
 */
export const MAX_PROMOTED_TOOLS = 30;

// --- Tasks ---

/**
 * Page size for `tasks__list`. A tenant's task count grows without
 * bound (one record per scheduled send), and an unpaged list is re-serialized
 * into the model's context on every call — at a few hundred records that is the
 * whole response budget, which is how a caller ends up silently working from a
 * partial view it believes is complete.
 *
 * Lives here rather than beside the schema because the connector handler needs the
 * value at runtime and the schema needs it at module load; importing it from
 * the schema module closes a cycle (TDZ at first call).
 */
export const TASKS_LIST_DEFAULT_LIMIT = 100;
export const TASKS_LIST_MAX_LIMIT = 500;
