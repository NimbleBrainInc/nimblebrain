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
 * Thrown when the owner of a conversation tries to RESUME it but is no longer a
 * member of the workspace the conversation lives in. A conversation is sealed to
 * its workspace (its tools/skills/apps resolve there), so resuming it as a
 * non-member would hand someone offboarded from that workspace its tools —
 * ambient authority into a workspace they were removed from. Ownership is
 * necessary but not sufficient on resume: continued membership is also required.
 *
 * Reads stay owner-gated (a removed member can still READ their own authored
 * conversation); this gates only the active/resume path. Subclasses
 * `ConversationAccessDeniedError` so it inherits the same
 * `403 conversation_access_denied` HTTP mapping (the caller learns only "no
 * access"), while staying a distinct type so logs/telemetry/tests can tell an
 * offboarding denial from an ownership denial. Personal workspaces are
 * sole-member by construction, so this only ever fires for shared workspaces.
 */
export class ConversationWorkspaceAccessDeniedError extends ConversationAccessDeniedError {
  constructor(
    conversationId: string,
    userId: string,
    public readonly conversationWorkspaceId: string,
  ) {
    super(conversationId, userId);
    this.name = "ConversationWorkspaceAccessDeniedError";
  }
}

/**
 * Thrown when a conversation file on disk fails the Stage 1 invariant
 * check at load time — specifically, a pre-migration file that lacks
 * `ownerId`. The store can't synthesize an owner safely and the chat
 * runtime can't authorize access on it.
 *
 * Operator action is manual: an ownerless file has no derivable owner, so no
 * migration could recover it — such files predate the ownership invariant and
 * were skipped by the one-time workspace migration rather than guessed at.
 * Recovery is to stamp an `ownerId` on the file's
 * line-1 metadata (when the owner is known) or remove the file. Without this
 * typed error, the unwrapped `Error("missing ownerId in ...")` from
 * `event-sourced-store` bubbles to `handleChat` as a 500; with it, the HTTP
 * layer returns a clean `422 conversation_corrupted` that explains the triage.
 */
export class ConversationCorruptedError extends Error {
  readonly code = "conversation_corrupted";
  constructor(
    public readonly conversationId: string,
    public readonly reason: "missing_owner",
  ) {
    super(
      `Conversation ${conversationId} is corrupted (${reason}): the file predates the ` +
        `ownership invariant and has no ownerId. No migration stamps these — add an ownerId ` +
        `to its line-1 metadata or remove the file.`,
    );
    this.name = "ConversationCorruptedError";
  }
}
