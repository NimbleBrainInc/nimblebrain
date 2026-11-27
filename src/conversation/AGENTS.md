# Conversations

Scope: how the kernel reads and writes conversations (`src/conversation/`). Workspace-level rules are in `src/workspace/AGENTS.md`; how the bound server is started and called is in `src/plugins/AGENTS.md`.

## One path: the conversations contract

The kernel keeps no conversation storage of its own. Every conversation is held by the plugin
bound to `ai.nimblebrain.conversations` (ADR-0076): by default the built-in plugin in
`packages/conversations`, which the default configuration binds (`src/config/plugins.ts`).

- **`contract-store.ts` is the store.** `runtime.workspaceConversationStore` hands out a
  `ConversationEventStore` (`types.ts`) from it; every operation is a `host` call to the bound
  server: `create`, `append_events`, `events`, `delete`, `delete_workspace`, and the `get`,
  `list` and `update` projections. The kernel never reads the plugin's files.
  `ConversationEventStore` stays as an interface because the run door, history, compaction,
  compose and skills are written against what a turn needs from a store, not against the
  contract client; the adapter is its one implementation, and tests drive the same adapter
  over the plugin in process (`test/helpers/conversation-store.ts`).
- **`events.ts` is what a turn stores**: one function maps an engine event to its stored event
  (`conversationEventOf`), one a stored message (`messageEvents`).
- **Per-conversation state is keyed by scope and id, never the id alone** (`conversationKey`
  in `contract-store.ts`): a conversation id is unique only within its workspace and owner
  (CONTRACT.md §2). The write queues, the turn lock, the run bus and the SSE viewers of a turn
  all use it, so a batch is sent only under the scope it was written in and a turn's state is
  never shared with the same id in another scope.
- **Writes are queued per conversation and sent in batches**, in order; a read of a
  conversation waits for its queued writes. An append is never retried (the contract has no
  idempotency key). Shutdown flushes the queues before the server stops.
- **Chat exists only while the contract is bound.** With nothing bound
  (`plugins: { conversations: false }`), `runtime.isChatEnabled()` is false: a chat or a write
  throws `ChatDisabledError` (every chat route answers `404 chat_disabled` first, through
  `requireChat`), a lookup finds nothing, and a listing is empty. A run with no conversation,
  such as a task, needs none.
- **A conversation the plugin cannot read is `ConversationCorruptedError`** (`422
  conversation_corrupted` on every route). The private tools answer `conversation_corrupted`;
  the public `get` answers such a conversation as absent, so a miss on `get` asks `events`,
  which tells the two apart.
- **`active` on a relayed `list` is the host's fact.** The plugin reports what it can know; the
  bound source overlays every row's `active` from the run bus (`overlayListActive`) on every
  `list` it relays, to agents, the door and apps.
- **Cost is not a conversation's.** The contract never prices (CONTRACT.md §4, §8); a turn's cost
  is on its usage, and spend on the usage ledger.

## Conversations are workspace-owned

Every call is walled to one workspace and one owner (the contract's scope), and authorized by ownership.

- **The binding is the session's workspace for the whole turn, and the request names it.** A chat runs in the workspace its request addresses (`/v1/workspaces/<wsId>/chat*`, ADR-0037): a new conversation is born there, and a resume must name a conversation already stored there. `Runtime.assertConversationInWorkspace` asks the plugin within the caller's own scope in that workspace; a conversation in another workspace, another owner's, and an unknown id all throw `ConversationNotFoundError` (`404 conversation_not_found`), so the answer reveals neither existence nor location. The upload handlers ask the same question before storing a file. So `_chatInner`'s tools, skills, apps, file partition, and `## Workspace` block (`convWsId`) are the request's workspace and the conversation's at once; there is no relocation.
- **No conversation read or write crosses a workspace.** Every operation that finds a conversation by id names the workspace it looks in, taken from the route (`/v1/workspaces/<wsId>/conversations/<id>/events`, `…/cancel`) or the request context (`skills__loading_log`, `compose__effective_context`, skill-mute suppression), never discovered by searching other workspaces; with no workspace in scope they throw. A conversation stored in another workspace answers exactly like one that does not exist (`404 conversation_not_found`, never `403`).
- **READ is owner-gated within its workspace; RESUME also requires current membership.** `findConversation(wsId, convId, access)` asks only within `access.userId`'s scope of `wsId`, so another owner's conversation is not found either. The HTTP routes that read a conversation sit behind `requireWorkspace`, the membership gate of every `/v1/workspaces/<wsId>/…` route. **Resuming** binds the session's tools/skills/apps to `convWsId`, so it would hand the workspace's tools to someone offboarded from it: `chat()` and `startTurn()` both re-check membership of the conversation's workspace on resume and throw `ConversationWorkspaceAccessDeniedError` (→ `403`) for a non-member. This is a per-**resume** check (once per conversation load, at session establishment), NOT the per-call scan the wall forbids. Tasks carry the same shape and gate per run; files do not gate on membership today. The check (`isPrincipalWorkspaceMember`) also refuses a deactivated user (`deletedAt`), so unattended work stops at deactivation and resumes on restore.
- **There is no cross-workspace listing.** Not an internal primitive, not behind a flag. `listConversations` reads exactly one owner's conversations in one workspace, and both are required arguments.
- **The kernel decides that a workspace exists.** The plugin trusts the workspace the kernel stamps and makes storage for it on first use, so the adapter's `create`, the one call that makes storage, first passes `assertWorkspaceRootExists` on the kernel's own workspace root.
- **A deleted workspace's conversations stay until its purge**, so a restore finds them (`src/workspace/AGENTS.md`). The adapter's `create` refuses a deleted workspace as well as a missing root, so none is made in one. The purge calls the contract's `delete_workspace` as `host` under the deleting identity, after `settle` waits for any `create` already past that check and flushes queued writes. A refusal leaves the tombstone, and the next pass calls it again.

| Operation | Use | Never |
|---|---|---|
| Read one | `runtime.findConversation(wsId, convId, { userId })` | a lookup that searches other workspaces |
| Open its store | `runtime.resolveConversationStore(wsId, convId, ownerId)` | |
| List | `runtime.listConversations(wsId, options, { userId })` | any cross-workspace variant |
| Write | `runtime.workspaceConversationStore(wsId, ownerId)` | a path into the plugin's data directory |
