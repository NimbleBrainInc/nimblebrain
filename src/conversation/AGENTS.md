# Conversations

Scope: conversation storage, paths, and the locator (`src/conversation/`). Workspace-level rules are in `src/workspace/AGENTS.md`.

## Conversations are workspace-owned

Every conversation lives at `workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl` and is authorized by ownership (`Conversation.ownerId === access.userId`).

- **The path is the binding.** `Conversation.workspaceId` is set at create (the workspace the chat is born in, at the first message) and never mutated — there is no mid-chat workspace switching — so the directory is authoritative and the field is a denormalised convenience. **Both** conversation walls key on the directory: `ConversationLocator` parses it from the path, and the `conversations__*` index takes it from the directory the scan descended through. Neither reads the line-1 field, so a record is in exactly the workspace it is stored under and there is no "unstamped" case to fold in.
- **The binding is the session's workspace for the whole turn, and the request names it.** A chat runs in the workspace its request addresses (`/v1/workspaces/<wsId>/chat*`, ADR-0037): a new conversation is born there, and a resume must name a conversation already stored there. `Runtime.assertConversationInWorkspace` probes the caller's own partition of that workspace; a conversation in another workspace, another owner's, and an unknown id all throw `ConversationNotFoundError` (`404 conversation_not_found`), so the answer reveals neither existence nor location. The upload handlers ask the same question before storing a file. So `_chatInner`'s tools, skills, apps, file partition, and `## Workspace` block (`convWsId`) are the request's workspace and the conversation's at once; there is no locator walk on the chat path and no relocation.
- **READ stays owner-gated; RESUME also requires current membership.** Reading an owned conversation (`findConversation`, the SSE event stream) consults ownership only — a removed member can still read their own authored conversation. But **resuming** binds the session's tools/skills/apps to `convWsId`, so it would hand the workspace's tools to someone offboarded from it: `chat()` and `startTurn()` both re-check membership of the conversation's workspace on resume and throw `ConversationWorkspaceAccessDeniedError` (→ `403`) for a non-member. This is a per-**resume** check (once per conversation load, at session establishment — exactly where the wall says the workspace must be membership-validated), NOT the per-call scan the wall forbids. Personal workspaces are sole-member by construction, so they never gate. Automations carry the same shape and gate per run; files do not gate on membership today.
- **There is no cross-workspace listing.** Not an internal primitive, not behind a flag. `listConversations` covers exactly one workspace, and the workspace is a required argument. The tenant-wide raw-file read that usage aggregation needs is `listAllConversationFiles` — a separate function returning paths with no owner filter and no summaries, so it can never be mistaken for a conversation view. Reading a conversation **by id** stays cross-workspace and owner-gated (deep links and the chat panel's workspace reconcile need it).

| Operation | Use | Never |
|---|---|---|
| Build a dir | `workspaceConversationsDir` (`src/conversation/paths.ts`) | flat `join(workDir, "conversations")` — `check:conversation-paths` catches it |
| Read one | `runtime.findConversation(convId, { userId })` | |
| List | `runtime.listConversations(workspaceId, options, access)` | any cross-workspace variant |
| Write | `runtime.workspaceConversationStore(wsId, ownerId)` | |
| Personal workspace id | `personalWorkspaceIdFor(userId)` (`src/workspace/workspace-store.ts`) | hand-built `"ws_user_" + userId` or the template-literal form — `check:personal-workspace-id` enforces |

Both read paths route through the process-wide `ConversationLocator`, which resolves `convId → { wsId, ownerId }` across workspaces. Deleting a workspace **archives** its subtree to `archived/<wsId>/` (archive-then-cascade), never a hard `rm`.
