/**
 * Per-tab persistence of the last-viewed conversation id.
 *
 * Stored in `sessionStorage` so it is:
 *   - site-scoped (per-origin) and never sent to the server,
 *   - per-tab (two tabs don't clobber each other's active conversation),
 *   - cleared automatically when the tab closes (no stale-id cleanup).
 *
 * On a fresh page load the chat panel reads this and re-opens the
 * conversation, which re-subscribes to the server turn stream — so an
 * in-flight turn's streaming indicator resumes (the actual stream lives
 * server-side; only the id needs remembering). The `/chat/:id` route
 * restores from the URL instead and doesn't use this.
 */

const KEY = "nb:activeConversationId";

export function getSavedConversationId(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    // sessionStorage can throw in private-mode / sandboxed contexts.
    return null;
  }
}

export function setSavedConversationId(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(KEY, id);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Best-effort — persistence is an enhancement, not a correctness path.
  }
}
