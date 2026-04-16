// --- Engine Hard Caps ---

/** Absolute ceiling on agentic iterations. Not configurable. */
export const MAX_ITERATIONS = 50;

/** Maximum characters in a tool result before truncation for the LLM. */
export const MAX_TOOL_RESULT_CHARS = 50_000;

// --- Runtime Defaults ---

export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_MAX_INPUT_TOKENS = 500_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
export const DEFAULT_MAX_DIRECT_TOOLS = 30;

// --- Delegation ---

export const DEFAULT_CHILD_ITERATIONS = 5;
export const MAX_CHILD_ITERATIONS = 10;
