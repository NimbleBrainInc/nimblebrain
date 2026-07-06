/**
 * Structure-aware markdown truncator.
 *
 * Replaces mid-string `slice(0, N)` truncation with a heading-aware walk that
 * preserves whole sections. When a skill is too large to fit the prompt
 * budget, we'd rather drop the last few sections cleanly than chop a sentence
 * in half — the latter has bitten production (a bundle's "rules" appendix at
 * the end was lost mid-rule, leaving the model with half a directive).
 *
 * Algorithm:
 *   1. Split body by markdown headings (lines starting with `#`).
 *   2. Walk sections in document order, summing chars; stop when next would
 *      exceed budget.
 *   3. If anything was dropped, append `[truncated: N sections omitted]`.
 *   4. If the very first section alone exceeds the budget, fall back to
 *      truncating at the last paragraph break (`\n\n`) within budget, or
 *      finally a line break — never mid-line if avoidable.
 *
 * Pure function. No I/O. Stable output for stable inputs.
 */

/**
 * Per-skill body ceiling (chars), applied when a skill body is rendered into the
 * PROMPT (heading-aware via `truncateMarkdownToBudget`). ~12000 chars ≈ 3000 tokens.
 *
 * Threat model: this backstops UNVETTED user/workspace Layer-3 skills, which were
 * injected into the prompt uncapped before this change — a single oversized one
 * could blow the context budget. Vendored core/builtin skills are trusted and well
 * under the cap; they are not the reason it exists. That "user skills are
 * untrusted" framing is also why the per-skill cap is kept while the aggregate
 * Layer-3 budget was deferred as inert-ahead-of-need.
 *
 * Applied ONLY on the prompt-load path (`parseSkillFileGuarded` passes
 * `{ cap: true }`); every read/inspect/round-trip caller gets the full stored
 * body by default, so editing never persists a truncated file. Also caps the
 * bundle `skill://<name>/usage` body. Tune against a measured baseline.
 */
export const MAX_SKILL_BODY_CHARS = 12_000;

export interface TruncateResult {
  body: string;
  truncated: boolean;
  /** Number of whole sections dropped. 0 if no truncation, or single-section fallback. */
  sectionsOmitted: number;
}

/**
 * Split a markdown body into sections, each starting at a heading line
 * (`#`, `##`, `###`, etc.). The preamble before the first heading (if any)
 * is returned as the first section.
 */
function splitIntoSections(content: string): string[] {
  const lines = content.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    // A heading is `#{1,6} ` at the start of the line. Markdown allows up to 6.
    const isHeading = /^#{1,6}\s/.test(line);
    if (isHeading && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current.join("\n"));
  }
  return sections;
}

/**
 * Truncate the leading section to fit `maxChars`. Prefers a paragraph break
 * (`\n\n`) inside the budget, then a single line break, then a hard cut.
 */
function truncateSingleSection(section: string, maxChars: number): string {
  if (section.length <= maxChars) return section;
  const slice = section.slice(0, maxChars);

  // Prefer the last paragraph break in the slice.
  const paragraphIdx = slice.lastIndexOf("\n\n");
  if (paragraphIdx > 0) {
    return slice.slice(0, paragraphIdx);
  }

  // Fall back to the last newline.
  const lineIdx = slice.lastIndexOf("\n");
  if (lineIdx > 0) {
    return slice.slice(0, lineIdx);
  }

  // No structural anchor — hard cut.
  return slice;
}

/** Build the trailing marker naming how many whole sections were dropped. */
function omittedMarker(omitted: number): string {
  return `\n\n[truncated: ${omitted} section${omitted === 1 ? "" : "s"} omitted]`;
}

/** Truncate the overlong first section in place, marking the rest omitted. */
function truncateOverlongFirstSection(sections: string[], budget: number): TruncateResult {
  const head = truncateSingleSection(sections[0]!, budget);
  const omitted = sections.length - 1; // everything after the (partial) first section
  const marker = omitted > 0 ? omittedMarker(omitted) : "\n\n[truncated]";
  return { body: head + marker, truncated: true, sectionsOmitted: omitted };
}

/** Keep whole sections in order until the next would exceed budget. */
function walkSections(sections: string[], budget: number): { kept: string[]; omitted: number } {
  const kept: string[] = [];
  let total = 0;
  let omitted = 0;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    // +1 for the implicit newline join between sections (split removed them).
    const next = total + section.length + (kept.length > 0 ? 1 : 0);
    if (next > budget) {
      omitted = sections.length - i;
      break;
    }
    kept.push(section);
    total = next;
  }
  return { kept, omitted };
}

/**
 * Truncate markdown content to fit within `maxChars`, preferring section
 * boundaries over mid-string slicing.
 *
 * Returns `{ body, truncated, sectionsOmitted }`. `body` includes the
 * `[truncated: …]` marker when truncation occurred; callers don't need to
 * add their own. Marker text follows the convention from the prior
 * `slice + "\n\n[truncated]"` implementation, expanded to include the count
 * for observability.
 */
export function truncateMarkdownToBudget(content: string, maxChars: number): TruncateResult {
  if (maxChars <= 0) {
    return { body: "", truncated: content.length > 0, sectionsOmitted: 0 };
  }
  if (content.length <= maxChars) {
    return { body: content, truncated: false, sectionsOmitted: 0 };
  }

  const sections = splitIntoSections(content);

  // Reserve a small budget for the trailing marker so we don't overflow when
  // we add it. The marker is short (~50 chars) but we pad to be safe.
  const MARKER_RESERVE = 64;
  const effectiveBudget = Math.max(0, maxChars - MARKER_RESERVE);

  // Edge case: the first section alone is over budget. Fall back to
  // intra-section truncation at a paragraph/line break.
  if (sections.length > 0 && sections[0]!.length > effectiveBudget) {
    return truncateOverlongFirstSection(sections, effectiveBudget);
  }

  // Walk sections, accumulating until adding the next would exceed budget.
  const { kept, omitted } = walkSections(sections, effectiveBudget);

  const body = kept.join("\n");
  if (omitted === 0) {
    // Shouldn't normally hit this branch since content.length > maxChars,
    // but mathematically possible with the marker reserve. Return as-is.
    return { body, truncated: false, sectionsOmitted: 0 };
  }
  return {
    body: body + omittedMarker(omitted),
    truncated: true,
    sectionsOmitted: omitted,
  };
}
