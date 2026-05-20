/** Thrown when a chat request arrives for a conversation that already has an active run. */
export class RunInProgressError extends Error {
  readonly code = "run_in_progress";
  constructor(public readonly conversationId: string) {
    super(`Conversation ${conversationId} already has an active run`);
    this.name = "RunInProgressError";
  }
}

/**
 * Thrown when a caller attempts to read or write a conversation they
 * don't own. Stage 1 is single-owner: the conversation's `ownerId`
 * must match the requesting identity. Stage 4 will widen this with
 * policy-gated sharing.
 *
 * The HTTP handler maps this to `403 conversation_access_denied`.
 * Returning a `404` would be a defensible alternative (don't leak
 * existence), but the caller already supplied an authenticated
 * identity AND a specific conversation id — leaking "exists but not
 * yours" vs. "doesn't exist" is fine in that posture.
 */
export class ConversationAccessDeniedError extends Error {
  readonly code = "conversation_access_denied";
  constructor(
    public readonly conversationId: string,
    public readonly userId: string,
  ) {
    super(`Conversation ${conversationId} cannot be accessed by user ${userId}`);
    this.name = "ConversationAccessDeniedError";
  }
}

/**
 * Thrown when a conversation file on disk fails the Stage 1 invariant
 * check at load time — specifically, a pre-migration file that lacks
 * `ownerId`. The store can't synthesize an owner safely and the chat
 * runtime can't authorize access on it.
 *
 * Operator action is to run `bun run migrate:conversations-to-top-level`,
 * which stamps `ownerId` (skips files that genuinely have no owner
 * derivable; those need manual triage). Without this typed error, the
 * unwrapped `Error("missing ownerId in ...")` from `event-sourced-store`
 * bubbles to `handleChat` as a 500; with it, the HTTP layer can return
 * a clean `422 conversation_corrupted` that names the migration command.
 */
export class ConversationCorruptedError extends Error {
  readonly code = "conversation_corrupted";
  constructor(
    public readonly conversationId: string,
    public readonly reason: "missing_owner",
  ) {
    super(
      `Conversation ${conversationId} is corrupted (${reason}). ` +
        `Run \`bun run migrate:conversations-to-top-level\` to stamp ownerId on legacy files.`,
    );
    this.name = "ConversationCorruptedError";
  }
}
