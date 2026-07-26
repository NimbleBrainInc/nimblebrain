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
 * Kinds that occupy disjoint regions of the context window.
 *
 * `skills` is excluded deliberately: composed skill bodies live INSIDE the
 * system prompt, so that row annotates a slice of `system_prompt` rather than
 * adding a fourth region. Summing all four (which is what the recorded
 * `totalTokens` does) counts the skill bodies twice. See the invariant
 * documented on `AssembledContextSource`.
 */
const WINDOW_KINDS = new Set(["system_prompt", "tool_descriptions", "history"]);

/** Tokens actually occupying the context window, without the `skills` overlap. */
export function windowTokens(sources: readonly AssembledContextSource[]): number {
  return sources.filter((s) => WINDOW_KINDS.has(s.kind)).reduce((sum, s) => sum + s.tokens, 0);
}

/** Sources that occupy the window, in canonical display order. */
export function windowSources<T extends { kind: string }>(sources: readonly T[]): T[] {
  return orderedSources(sources).filter((s) => WINDOW_KINDS.has(s.kind));
}

/** The `skills` annotation row, when the run recorded one. */
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
