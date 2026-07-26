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
 * Kinds that ANNOTATE another row rather than occupying the window themselves.
 *
 * `skills` is one: composed skill bodies live INSIDE the system prompt, so that
 * row measures a slice of `system_prompt` rather than adding a region. See the
 * invariant documented on `AssembledContextSource`.
 *
 * Used ONLY to decide which rows lay out as regions. The window *total* is not
 * computed here — it arrives as `windowTokens` on the digest, so the number on
 * screen is the tool's own and can't drift from it. Stated as the annotation
 * set rather than an allowlist of regions so a kind added later renders by
 * default instead of vanishing.
 */
const ANNOTATION_KINDS = new Set(["skills"]);

/** Sources that occupy the window, in canonical display order. */
export function windowSources<T extends { kind: string }>(sources: readonly T[]): T[] {
  return orderedSources(sources).filter((s) => !ANNOTATION_KINDS.has(s.kind));
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
