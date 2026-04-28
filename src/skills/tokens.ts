/**
 * Approximate token count for a body of text.
 *
 * Phase 2 uses `Math.ceil(text.length / 4)` as a cheap stand-in. The
 * estimate is consistent across the platform (skills loader, runtime
 * telemetry, app-state truncation) so tokens reported in `skills.loaded`
 * match what `compose.ts` would budget against.
 *
 * Phase 5 will swap this for a model-specific tokenizer once attribution
 * lands; centralising the math here means a single point to replace.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
