# Conversations

Scope: conversation storage and paths (`src/conversation/`). Workspace-level rules are in `src/workspace/AGENTS.md`.

## Conversations are workspace-owned

Every conversation lives at `workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl` and is authorized by ownership (`Conversation.ownerId === access.userId`).

- **The path is the binding.** `Conversation.workspaceId` is set at create (the workspace the chat is born in, at the first message) and never mutated — there is no mid-chat workspace switching — so the directory is authoritative and the field is a denormalised convenience. Every read keys on the directory: the runtime's reads open one workspace's partition by path, and the `conversations__*` index takes the workspace from the directory the scan descended through. Neither reads the line-1 field, so a record is in exactly the workspace it is stored under and there is no "unstamped" case to fold in.
- **The binding is the session's workspace for the whole turn, and the request names it.** A chat runs in the workspace its request addresses (`/v1/workspaces/<wsId>/chat*`, ADR-0037): a new conversation is born there, and a resume must name a conversation already stored there. `Runtime.assertConversationInWorkspace` probes the caller's own partition of that workspace; a conversation in another workspace, another owner's, and an unknown id all throw `ConversationNotFoundError` (`404 conversation_not_found`), so the answer reveals neither existence nor location. The upload handlers ask the same question before storing a file. So `_chatInner`'s tools, skills, apps, file partition, and `## Workspace` block (`convWsId`) are the request's workspace and the conversation's at once; there is no relocation.
- **No conversation read or write crosses a workspace.** Every operation that finds a conversation by id names the workspace it looks in, taken from the route (`/v1/workspaces/<wsId>/conversations/<id>/events`, `…/cancel`) or the request context (`skills__loading_log`, `compose__effective_context`, skill-mute suppression), never discovered by searching other workspaces; with no workspace in scope they throw. A conversation stored in another workspace answers exactly like one that does not exist (`404 conversation_not_found`, never `403`), so an answer reveals neither existence nor location.
- **READ is owner-gated within its workspace; RESUME also requires current membership.** `findConversation(wsId, convId, access)` opens only `access.userId`'s partition of `wsId`, so another owner's conversation is not found either. The HTTP routes that read a conversation sit behind `requireWorkspace`, the membership gate of every `/v1/workspaces/<wsId>/…` route. **Resuming** binds the session's tools/skills/apps to `convWsId`, so it would hand the workspace's tools to someone offboarded from it: `chat()` and `startTurn()` both re-check membership of the conversation's workspace on resume and throw `ConversationWorkspaceAccessDeniedError` (→ `403`) for a non-member. This is a per-**resume** check (once per conversation load, at session establishment — exactly where the wall says the workspace must be membership-validated), NOT the per-call scan the wall forbids. Tasks carry the same shape and gate per run; files do not gate on membership today. The check (`isPrincipalWorkspaceMember`) also refuses a deactivated user (`deletedAt`), so unattended work stops at deactivation and resumes on restore.
- **There is no cross-workspace listing.** Not an internal primitive, not behind a flag. `listConversations` reads exactly one owner partition of one workspace, and both are required arguments.

| Operation | Use | Never |
|---|---|---|
| Build a dir | `workspaceConversationsDir` (`src/conversation/paths.ts`) | flat `join(workDir, "conversations")` — `check:conversation-paths` catches it |
| Read one | `runtime.findConversation(wsId, convId, { userId })` | a lookup that searches other workspaces |
| Open its store | `runtime.resolveConversationStore(wsId, convId, ownerId)` | |
| List | `runtime.listConversations(wsId, options, { userId })` | any cross-workspace variant |
| Write | `runtime.workspaceConversationStore(wsId, ownerId)` | |

Each read opens the one partition its arguments name; nothing resolves an id to a workspace. Deleting a workspace **archives** its subtree to `archived/<wsId>/` (archive-then-cascade), never a hard `rm`.
