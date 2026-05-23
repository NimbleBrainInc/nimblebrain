/**
 * Shared `NB_DEBUG_BRIEFING` gating for briefing-side diagnostic logs.
 *
 * The flag is read at call time (not at module load) so flipping it
 * via env at startup or via runtime config reload takes effect on the
 * next briefing tick. Builds the message lazily to keep the gate cheap
 * when disabled.
 *
 * Usage:
 *   debugBriefing(() => `facet=${name} ok=${ok}`);
 */
export function debugBriefing(message: () => string): void {
  if (!process.env.NB_DEBUG_BRIEFING) return;
  console.log(`[briefing.debug] ${message()}`);
}
