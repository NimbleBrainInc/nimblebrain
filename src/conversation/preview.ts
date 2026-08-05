/**
 * The wire cap for a conversation `preview`.
 *
 * A preview is a conversation's first user message, and it goes out on tool
 * responses — so it lands in the agent's context window and its token budget,
 * not just a UI payload. Uncapped, one conversation opened by pasting a long
 * document carries that whole document into every call that returns it, and
 * `conversations__list` returns twenty rows by default.
 *
 * **Cap at the wire, never at the index.** The stored preview backs the
 * case-insensitive substring match behind `list?search=` (`index-cache.ts`) and
 * the locator's own list filter, so truncating at production would silently
 * narrow recall — a search for a term deep in a pasted document would stop
 * matching. Producers keep the full string; every site that puts it on a wire
 * caps it here.
 *
 * The preview is also the only human-readable label on a row (a summary has no
 * title until one is generated), so it is capped rather than dropped: enough to
 * recognise the conversation by.
 */

export const PREVIEW_MAX_CHARS = 200;

/**
 * Cap `text` at {@link PREVIEW_MAX_CHARS}, preferring the last word boundary in
 * the final quarter so the label doesn't end mid-word. The ellipsis counts
 * against the cap, so the result is never longer than the cap.
 */
export function capPreview(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  const head = text.slice(0, PREVIEW_MAX_CHARS - 1);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace > PREVIEW_MAX_CHARS * 0.75 ? head.slice(0, lastSpace) : head;
  return `${cut}…`;
}
