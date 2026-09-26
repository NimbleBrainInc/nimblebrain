# Web client

Scope: the first-party React shell under `web/` (a separate package). Layout, type, and visual rules are in `web/DESIGN.md`; the iframe bridge has its own guide at `web/src/bridge/AGENTS.md`. The server-side write rule this mirrors is in `src/workspace/AGENTS.md`.

## Gating a workspace write

**Workspace-scoped writes have no org-admin bypass, and the web tier must agree.** `canWriteWorkspaceScoped` (`src/workspace/authz.ts`) allows a write only for a workspace **member** whose membership role is `admin`; `orgRole` is never consulted. The web tier's `useScopedRole` deliberately does the opposite — it escalates an org admin to `org_admin` *before* reading the workspace role — because that is the right answer for **reach** (nav, route guards, read gates), where an org admin legitimately gets to any workspace's settings. So the two must not share a helper. Gate a **write** with `canWriteWorkspace(membershipRole)` (`web/src/hooks/useScopedRole.ts`) — via `useCanWriteActiveWorkspace()` on a surface scoped to the active workspace (anything under `/w/:slug`), or by passing that workspace's role directly when the surface addresses a workspace **by id** (`/org/workspaces/:slug`, where `activeWorkspace` is the viewer's last-focused workspace — usually their personal one, where they are always admin by store invariant, so the active-workspace form would answer `true` for everyone). Reserve `roleAtLeast(role, "ws_admin")` for reach. Getting this backwards offers controls the server refuses and surfaces as a 403 on save. It shipped in nine places before being caught, in three different shapes — `roleAtLeast(…, "ws_admin")`, the bypass written longhand as `isOrgAdmin || <membership check>`, and an affordance with no gate at all — so grepping for one shape never establishes that a surface is covered.

## Shell rules

- `SlotRenderer` effect depends only on `placementKey` (callbacks via refs, not deps)
- Shell components must not consume `ChatContext` (use `ChatConfigContext` instead)
- `setAuthToken` in `web/src/api/client.ts` fires a registered lifecycle handler on real changes only (equality-guarded). The bridge MCP client registers `resetMcpBridgeClient` here at module load to drop its identity-bound session on logout. `setActiveWorkspaceId` is also equality-guarded and fires the separate workspace lifecycle handlers (`addWorkspaceLifecycleHandler`), never the auth ones; the bridge registers `resetMcpBridgeClient` there too, because its session is bound to the workspace whose `/mcp/<wsId>` it opened. `getMcpBridgeClient` also keys its cache by the active workspace, so a request for workspace B never rides A's session even mid-switch. Stateless callers (REST helpers) read the current values per-request and need no hook.

## The chat panel's workspace scope

`ChatProvider` (`web/src/context/ChatContext.tsx`) watches the **focus** workspace, derived from the `/w/:slug` route and membership-gated. Never from `WorkspaceContext`'s `activeWorkspace`, which starts on bootstrap's default and reconciles to the route a render later — keying focus off that intermediate value looks like a workspace switch and clears the conversation the per-tab restore just reopened. Reading `activeWorkspace` is fine for display-only consumers; it is the *focus* decision that must come from the route.

Re-scoping uses the narrow `newConversation()` (back to the panel's unsent chat, or a fresh one once a send was attempted in it; an unsent chat has no workspace until its first send), **not** `chatStore.reset()` (that is the identity-change broad reset). A conversation belongs to one workspace, so the panel doesn't carry it into another. Two triggers:

1. **In-session switch.** `A→B` re-scopes and clears the open conversation. A `null` focus on home/identity routes is *held*, not reset, so `A→home→A` keeps context.
2. **Mount / async-focus reconcile.** After a refresh the panel restores the last conversation from per-tab storage with no transition to catch a workspace mismatch. Once the conversation's own workspace is known (`conversationMeta.workspaceId`, from `conversations__get`) it re-scopes if that differs from the focus. This fires only when the workspace is **known** — a not-yet-loaded conversation is left alone, which is the open-in-progress race guard.

Opening a conversation from within its own workspace doesn't change focus and matches, so it isn't cleared.

**The reconcile is the single guard.** `useChat` knows nothing about workspaces, so do not add a send-time backstop: by the time a send can run, the passive reconcile effect has already re-scoped the panel. The runtime still binds a resumed turn to the conversation's OWN workspace regardless of focus (the seal), so a mis-target is a wrong-conversation-selected bug, never a cross-workspace leak.

## Web Shell — Main-Area Views Beside the Docked Chat

`ShellLayout` renders left-nav | routed main area | docked chat (`ChatChrome`). Routed views under `/w/:slug/...` (e.g. `context/:convId`) render in the main-area slot **left of the chat** — their width is that chat-adjacent column, which shrinks as the chat docks or the window narrows. It is **not** the viewport width. How to lay that out (container queries, never viewport breakpoints) is in **`web/DESIGN.md`**, along with type, the opacity ramp, and the ambient-chrome default.

- **A routed element is reused across a param-only change.** The `/w/` prefix keeps `ChatChrome` mounted, so React Router keeps the same component instance alive when only the param changes (`context/:convId` A→B) — refs and state persist across the switch. On the param change you MUST (1) reset per-entity view state (selection/expansion and any `useRef` latch) and (2) cancel the previous entity's in-flight reads via an effect-cleanup flag. An unconditional `setState` in a stale `.then` lands entity A's data (its budget, its body) under entity B. See the load effect in `ContextInspectorPage.tsx`.
