/**
 * Display helpers for `context.assembled` budget sources — shared by the
 * In-context popover and the context inspector so their labels, order, and
 * arithmetic can't drift. (`formatTokenCount` is likewise shared, from
 * `lib/skill-display`.)
 */
import type { AssembledContextSource } from "../_generated/platform-schemas/compose";

/** Canonical display order of the budget sources. Unknown kinds sort last. */
export const SOURCE_ORDER = ["system_prompt", "tool_descriptions", "skills", "history"];

/** Human labels for the budget sources. */
export const SOURCE_LABEL: Record<string, string> = {
  system_prompt: "System prompt",
  tool_descriptions: "Tools",
  skills: "Skills",
  history: "History",
};

/**
 * Sources that occupy the window, in canonical display order.
 *
 * Which rows are regions and which annotate another row is the server's call —
 * it stamps `annotation` on each row from the same set it sums `windowTokens`
 * over. Reading the stamp rather than keeping a local list of annotation kinds
 * is what keeps these rows and the total printed under them in agreement; a
 * second copy of that list here could render a region whose tokens aren't in
 * the figure below it.
 */
export function windowSources<T extends { kind: string; annotation?: boolean }>(
  sources: readonly T[],
): T[] {
  return orderedSources(sources).filter((s) => !s.annotation);
}

/**
 * The `skills` annotation row, when the run recorded one. Keyed by kind, not by
 * the `annotation` stamp: this is the row the popover nests under the system
 * prompt specifically, which is a fact about skills, not about annotations in
 * general.
 */
export function skillsSlice<T extends { kind: string }>(sources: readonly T[]): T | undefined {
  return sources.find((s) => s.kind === "skills");
}

/** Sources in canonical display order (a stable copy; input is not mutated). */
export function orderedSources<T extends { kind: string }>(sources: readonly T[]): T[] {
  const rank = (kind: string) => {
    const i = SOURCE_ORDER.indexOf(kind);
    return i === -1 ? SOURCE_ORDER.length : i;
  };
  return [...sources].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** Count / messages / compacted detail suffix for a source row. */
export function sourceDetail(s: AssembledContextSource): string {
  const parts: string[] = [];
  if (typeof s.count === "number") parts.push(`${s.count}`);
  if (typeof s.messages === "number")
    parts.push(`${s.messages} message${s.messages === 1 ? "" : "s"}`);
  if (s.compacted) parts.push("compacted");
  return parts.join(" · ");
}
