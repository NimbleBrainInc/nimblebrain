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
 * don't own. Conversations are single-owner: the conversation's
 * `ownerId` must match the requesting identity.
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
 * Thrown when a chat or upload names a conversation that is not one of the
 * caller's conversations in the workspace the request addresses. A request
 * under `/v1/workspaces/<wsId>/` reaches only conversations stored under that
 * workspace (ADR-0037), so a conversation stored in another workspace, one
 * owned by someone else, and one that does not exist are one answer: the
 * caller learns nothing about where, or whether, the id exists.
 *
 * The HTTP handler maps this to `404 conversation_not_found`.
 */
export class ConversationNotFoundError extends Error {
  readonly code = "conversation_not_found";
  constructor(
    public readonly conversationId: string,
    public readonly workspaceId: string,
  ) {
    super(`Conversation ${conversationId} not found in workspace ${workspaceId}`);
    this.name = "ConversationNotFoundError";
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
 * offboarding denial from an ownership denial.
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
 * Thrown by `executeTask` when a task fires but its owner is no longer a
 * member of the task's provenance workspace. A task runs *as its
 * owner*, walled to the workspace it was created in — so a removed owner must
 * not keep acting in that workspace (the tasks analog of the conversation
 * resume gate). The stable `code` lets the tasks scheduler recognize this
 * outcome and record the run as **skipped** (not a failure — no consecutive-error
 * count, no auto-disable) so the task self-heals if the owner is re-added.
 */
export class WorkspaceMembershipRevokedError extends Error {
  readonly code = "workspace_membership_revoked";
  constructor(
    public readonly userId: string,
    public readonly workspaceId: string,
  ) {
    super(`User ${userId} is no longer a member of workspace ${workspaceId}`);
    this.name = "WorkspaceMembershipRevokedError";
  }
}

/**
 * Thrown when an unattended run's `allowedTools` names tools that nothing the
 * run can reach matches: their connector is missing, disconnected, or not
 * running. The owner declared those tools as the run's job, so the run cannot
 * do it, and it is refused before its first model call. The stable `code` lets
 * the tasks scheduler record the run as a **failure**, which a run that never
 * attempted the tool would otherwise not be (it ends normally and reads
 * Succeeded).
 */
export class DeclaredToolsUnavailableError extends Error {
  readonly code = "declared_tools_unavailable";
  constructor(public readonly tools: readonly string[]) {
    super(
      `Declared tool${tools.length === 1 ? "" : "s"} unavailable: ${tools.join(", ")}. ` +
        `Nothing this run can reach matches ${tools.length === 1 ? "it" : "them"}: the ` +
        `connector is missing, disconnected, or not running in this workspace, so the run ` +
        `did not start.`,
    );
    this.name = "DeclaredToolsUnavailableError";
  }
}

/**
 * Thrown when a conversation file on disk fails the ownership invariant
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
 * `event-sourced-store` bubbles to `handleChatStart` as a 500; with it, the HTTP
 * layer returns a clean `422 conversation_corrupted` that explains the triage.
 */
export class ConversationCorruptedError extends Error {
  readonly code = "conversation_corrupted";
  constructor(
    public readonly conversationId: string,
    public readonly reason: "missing_owner" | "missing_model",
  ) {
    super(
      reason === "missing_owner"
        ? `Conversation ${conversationId} is corrupted (${reason}): the file predates the ` +
            `ownership invariant and has no ownerId. No migration stamps these — add an ownerId ` +
            `to its line-1 metadata or remove the file.`
        : `Conversation ${conversationId} is corrupted (${reason}): the file predates the ` +
            `model binding and has no model. Add a provider-qualified model to its line-1 ` +
            `metadata or remove the file.`,
    );
    this.name = "ConversationCorruptedError";
  }
}

/**
 * Thrown when a chat request names a model the deployment does not permit.
 *
 * Only a caller-supplied concrete model reaches this. An omitted model and a
 * slot name both resolve to operator config, which is governed where it is
 * written (`set_model_config` validates, and the seed is the operator's own
 * file) — checking it here would refuse to start a deployment whose config
 * predates its allowlist.
 *
 * Rejecting rather than substituting a permitted model is deliberate: the
 * resolved value is written to `Conversation.model` at create and is immutable
 * for the conversation's life, so a silent substitution would pin the caller
 * to a model they did not ask for, permanently and without a signal.
 *
 * The HTTP handler maps this to `400 model_not_allowed`.
 */
export class ModelNotAllowedError extends Error {
  readonly code = "model_not_allowed";
  constructor(
    public readonly model: string,
    public readonly configuredProviders: string[],
  ) {
    super(
      `Model "${model}" is not permitted. Either its provider is not configured or it is not in the allowlist. ` +
        `Configured providers: ${configuredProviders.join(", ") || "(none)"}`,
    );
    this.name = "ModelNotAllowedError";
  }
}
