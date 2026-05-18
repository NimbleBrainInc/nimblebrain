/**
 * Minimum MTF trust score required for a bundle's content to influence the
 * model via the system prompt. Applied uniformly across every path that puts
 * bundle-authored bytes into model-visible context: `<app-guide>`, `<app-state>`,
 * and tool-affined Layer 3 skills synthesized from `skill://<bundle>/usage`.
 *
 * Bundles below this score still load and their tools still work — only their
 * declarative *guidance* (skill bodies, app state summaries) is withheld until
 * trust is established.
 */
export const MIN_TRUST_FOR_PROMPT_INJECTION = 50;
