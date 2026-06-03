import type { BriefingOutput, BriefingSection } from "./home-types.ts";

// Section categories in the order the model should read them — attention
// first (matches the generator's "surface these first" guidance), then
// recent activity, then what's coming up. Mirrors the schema enum in
// `src/tools/platform/schemas/home.ts` (BriefingSection.category) — NOT the
// stale names in the inline dashboard script.
const CATEGORY_ORDER: { category: BriefingSection["category"]; label: string }[] = [
  { category: "attention", label: "Needs attention" },
  { category: "recent", label: "Recent" },
  { category: "upcoming", label: "Coming up" },
];

/**
 * Render a `BriefingOutput` as human-readable markdown for the `content`
 * field of the `nb__briefing` tool result.
 *
 * The briefing body lives in `structuredContent` for the dashboard, but the
 * model only ever sees `content` (the engine feeds `extractTextForModel(content)`
 * back into the prompt — `structuredContent` never reaches it). A model-facing
 * tool's `content` must therefore carry the human-readable summary, per the
 * platform-tool contract (src/tools/platform/CLAUDE.md §2.1). Without this the
 * model receives only the status note and reports an empty briefing.
 */
export function renderBriefingText(briefing: BriefingOutput): string {
  const parts: string[] = [briefing.greeting];
  if (briefing.lede) parts.push(briefing.lede);

  for (const { category, label } of CATEGORY_ORDER) {
    const items = briefing.sections.filter((s) => s.category === category);
    if (items.length === 0) continue;
    const lines = [`## ${label}`, ...items.map((s) => `- ${s.text}`)];
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n");
}
