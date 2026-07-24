/**
 * Display helpers for `context.assembled` budget sources — shared by the
 * In-context popover and the context inspector so their labels and order can't
 * drift. (`formatTokenCount` is likewise shared, from `lib/skill-display`.)
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

/** Sources in canonical display order (a stable copy; input is not mutated). */
export function orderedSources<T extends { kind: string }>(sources: readonly T[]): T[] {
  const rank = (kind: string) => {
    const i = SOURCE_ORDER.indexOf(kind);
    return i === -1 ? SOURCE_ORDER.length : i;
  };
  return [...sources].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** Count / turns / compacted detail suffix for a source row. */
export function sourceDetail(s: AssembledContextSource): string {
  const parts: string[] = [];
  if (typeof s.count === "number") parts.push(`${s.count}`);
  if (typeof s.turns === "number") parts.push(`${s.turns} turn${s.turns === 1 ? "" : "s"}`);
  if (s.compacted) parts.push("compacted");
  return parts.join(" · ");
}
