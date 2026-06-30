/**
 * Neutralise every closing-tag form in untrusted `value` so it cannot break out
 * of the XML fence the conversation prompts wrap it in.
 *
 * The conversation fences — `<conversation-summary>` (compaction replay seed),
 * `<conversation-transcript>` / `<user-message>` / `<assistant-message>`
 * (summarizer and title-generation transcripts) — wrap content that traces back
 * to untrusted user and tool text. A body carrying its own closing tag could
 * otherwise close the fence early and inject top-level instructions.
 *
 * Unlike the system-prompt containment tags (tag-specific, see `wrapContained`
 * in `prompt/compose.ts`), a transcript can carry arbitrary tags, so this
 * neutralises ANY closing form `</…`. Two properties make it robust against the
 * model's fuzzy parsing:
 *   - whitespace-tolerant: `</tag>`, `< /tag>`, `</ tag>`, `</\ntag>` all match.
 *   - entity rewrite: the `<` becomes `&lt;`, so no literal `<` survives for the
 *     model to read as a tag boundary (stronger than a backslash disruptor).
 *
 * Idempotent: a re-escaped body has no remaining `<` before a `/` to match.
 */
export function escapeClosingTags(value: string): string {
  return value.replace(/<\s*\//g, "&lt;/");
}
