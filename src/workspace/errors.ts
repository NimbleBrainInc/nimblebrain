/**
 * Workspace-store invariant errors.
 *
 * The data layer is the source of truth for workspace invariants. The
 * store throws typed errors on violation; the HTTP layer maps each one to
 * a clean status code with a structured body. Mirrors the precedent set
 * by `ConversationCorruptedError` → 422 in `src/runtime/errors.ts`.
 */

/**
 * Why the personal-workspace invariant was violated. Each value names
 * exactly one rule, so the HTTP body's `reason` field is enough for
 * operators / clients to act without parsing the human message.
 *
 *  - `members_mutation`            — attempted to add/remove members or
 *                                    change the owner's role on a
 *                                    personal workspace. Members are
 *                                    locked to `[{ userId: ownerUserId,
 *                                    role: "admin" }]`.
 *  - `is_personal_frozen`          — attempted to flip the `isPersonal`
 *                                    flag after create (in either
 *                                    direction). Identity-bound at create
 *                                    time.
 *  - `owner_user_id_frozen`        — attempted to change `ownerUserId`
 *                                    on a personal workspace. The
 *                                    owner-of-record cannot be reassigned
 *                                    through a patch.
 *  - `owner_user_id_on_non_personal` — attempted to set `ownerUserId` on
 *                                    a workspace where `isPersonal !==
 *                                    true`. The two fields travel
 *                                    together; one without the other is
 *                                    forbidden.
 */
export type PersonalWorkspaceInvariantReason =
  | "members_mutation"
  | "is_personal_frozen"
  | "owner_user_id_frozen"
  | "owner_user_id_on_non_personal";

/**
 * Thrown when a `WorkspaceStore.create` or `WorkspaceStore.update` call
 * violates one of the personal-workspace invariants.
 *
 * Personal workspaces (`isPersonal === true`) are sole-owner by design:
 * the `members` array MUST be exactly `[{ userId: ownerUserId, role:
 * "admin" }]`, and the identity fields (`isPersonal`, `ownerUserId`) are
 * frozen at create time. These rules turn personal workspaces into a
 * stable per-user namespace that the rest of the platform (conversation
 * ownership, credential isolation, agent delegation) can reason about
 * without re-checking on every read.
 *
 * The HTTP handler maps this to `422 personal_workspace_invariant` with
 * a structured `{ error, reason, workspaceId }` body — same shape as
 * `ConversationCorruptedError`.
 */
export class PersonalWorkspaceInvariantError extends Error {
  readonly code = "personal_workspace_invariant";
  constructor(
    public readonly workspaceId: string,
    public readonly reason: PersonalWorkspaceInvariantReason,
    detail?: string,
  ) {
    super(
      `Personal-workspace invariant violated on ${workspaceId} (${reason})` +
        (detail ? `: ${detail}` : ""),
    );
    this.name = "PersonalWorkspaceInvariantError";
  }
}
