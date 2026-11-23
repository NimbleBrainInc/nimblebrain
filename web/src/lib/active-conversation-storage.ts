/**
 * Per-tab persistence of the last-viewed conversation and the workspace it
 * belongs to.
 *
 * Stored in `sessionStorage` so it is:
 *   - site-scoped (per-origin) and never sent to the server,
 *   - per-tab (two tabs don't clobber each other's active conversation),
 *   - cleared automatically when the tab closes (no stale-id cleanup).
 *
 * On a fresh page load the chat panel reopens the conversation, which
 * re-subscribes to the server turn stream, so an in-flight turn's streaming
 * indicator resumes (the stream lives server-side; only the id needs
 * remembering). A conversation is found only in its own workspace, so the
 * workspace is kept beside the id and a reload in another workspace restores
 * nothing. The `/chat/:id` route restores from the URL instead and doesn't
 * use this.
 */

const KEY = "nb:activeConversation";

export interface SavedConversation {
  conversationId: string;
  workspaceId: string;
}

export function getSavedConversation(): SavedConversation | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as SavedConversation).conversationId === "string" &&
      typeof (parsed as SavedConversation).workspaceId === "string"
    ) {
      return parsed as SavedConversation;
    }
    return null;
  } catch {
    // sessionStorage can throw in private-mode / sandboxed contexts, and a
    // value written by another version of the app may not parse.
    return null;
  }
}

export function setSavedConversation(saved: SavedConversation | null): void {
  try {
    if (saved) sessionStorage.setItem(KEY, JSON.stringify(saved));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Best-effort — persistence is an enhancement, not a correctness path.
  }
}
