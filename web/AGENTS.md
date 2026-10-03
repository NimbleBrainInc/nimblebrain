# Web client

Scope: the first-party React shell under `web/` (a separate package). Layout, type, and visual rules are in `web/DESIGN.md`; the iframe bridge has its own guide at `web/src/bridge/AGENTS.md`. The server-side write rule this mirrors is in `src/workspace/AGENTS.md`.

## Tests

`check:web-tests` (in `verify:static`) typechecks the suite (`src/**/*.test.ts(x)`, `src/**/__tests__`, `test/`) under `tsconfig.test.json`: web's strict config plus Bun's types. Every diagnostic fails, so a fixture, prop, or mock that no longer matches the code breaks the build instead of quietly asserting a shape the runtime cannot produce. Type a stub on the real signature — `mock<typeof ApiClient.fn>(…)` with `import type * as ApiClient from "../api/client"` — not on its inline body, which lets the stub drift. Import test APIs from `bun:test`; `bun test` also answers `vitest`, but tsc does not, and that file goes untyped.

## Gating a workspace write

**Workspace-scoped writes have no org-admin bypass, and the web tier must agree.** `canWriteWorkspaceScoped` (`src/workspace/authz.ts`) allows a write only for a workspace **member** whose membership role is `admin`; `orgRole` is never consulted. The web tier's `useScopedRole` deliberately does the opposite — it escalates an org admin to `org_admin` *before* reading the workspace role — because that is the right answer for **reach** (nav, route guards, read gates), where an org admin legitimately gets to any workspace's settings. So the two must not share a helper. Gate a **write** with `canWriteWorkspace(membershipRole)` (`web/src/hooks/useScopedRole.ts`) — via `useCanWriteActiveWorkspace()` on a surface scoped to the active workspace (anything under `/w/:slug`), or by passing that workspace's role directly when the surface addresses a workspace **by id** (`/org/workspaces/:slug`, where `activeWorkspace` is whatever workspace the viewer last opened, or none, and says nothing about the workspace the page addresses). Reserve `roleAtLeast(role, "ws_admin")` for reach. Getting this backwards offers controls the server refuses and surfaces as a 403 on save. It shipped in nine places before being caught, in three different shapes — `roleAtLeast(…, "ws_admin")`, the bypass written longhand as `isOrgAdmin || <membership check>`, and an affordance with no gate at all — so grepping for one shape never establishes that a surface is covered. **Membership is the exception**: managing a workspace's members is gated server-side by `canManageWorkspaceMembers`, which admits an org admin/owner, so the web gate is `canManageWorkspaceMembers(orgRole, membershipRole)` in `useScopedRole.ts`. That one is an org-admin bypass on purpose; do not rewrite it to `canWriteWorkspace`.

## Shell rules

- `SlotRenderer` effect depends only on `placementKey` (callbacks via refs, not deps)
- Shell components must not consume `ChatContext` (use `ChatConfigContext` instead)
- **The agent moves the screen only from a turn this tab sent and is watching live.** Host UI driven by a tool call (`nb__open_app` → the `openApp` action) listens through `chatStore.onToolDone`, which reports a finished call only on a connection `sendTurn` opened, once per call. Never drive UI from a rendered transcript or a resumed stream: history loads, reload re-attaches and other tabs replay the same calls, and each would move someone's screen again.
- `setAuthToken` in `web/src/api/client.ts` fires a registered lifecycle handler on real changes only (equality-guarded). The bridge MCP client registers `resetMcpBridgeClient` here at module load to drop its identity-bound session on logout. `setActiveWorkspaceId` is also equality-guarded and fires the separate workspace lifecycle handlers (`addWorkspaceLifecycleHandler`), never the auth ones; the bridge registers `resetMcpBridgeClient` there too, because its session is bound to the workspace whose `/mcp/<wsId>` it opened. `getMcpBridgeClient` also keys its cache by the active workspace, so a request for workspace B never rides A's session even mid-switch. Stateless callers (REST helpers) read the current values per-request and need no hook.

## The chat panel's workspace scope

`ChatProvider` (`web/src/context/ChatContext.tsx`) watches the **focus** workspace, derived from the `/w/:slug` route and membership-gated. Never from `WorkspaceContext`'s `activeWorkspace`, which reconciles to the route a render after the route changes — keying focus off that intermediate value looks like a workspace switch and clears the conversation the per-tab restore just reopened. Reading `activeWorkspace` is fine for display-only consumers; it is the *focus* decision that must come from the route.

The panel keeps its conversation and the URL's workspace in agreement, because a chat runs in the workspace its URL names and the server answers a conversation from any other workspace as unknown (`404 conversation_not_found`). When they disagree, one gives:

- **The URL, for a conversation the user chose.** `openConversation` (a `?chat=` deep link through `openPanel`, Recents, an app's `openConversation` action) marks the conversation followed; once its workspace is known and differs from the focus, the provider navigates to `/w/<its slug>`, and the arrival is not treated as a switch away from it. Only for a workspace the user belongs to.
- **The conversation, otherwise.** `loadConversation` alone (the per-tab restore) never moves the URL: the URL the user loaded wins. Re-scoping uses the narrow `newConversation()` (back to the panel's unsent chat, or a fresh one once a send was attempted in it; an unsent chat has no workspace until its first send), **not** `chatStore.reset()` (that is the identity-change broad reset).

Two triggers:

1. **In-session switch.** `A→B` re-scopes and clears the open conversation, unless the switch is the followed conversation arriving at its own workspace. A `null` focus on home/identity routes is *held*, not reset, so `A→home→A` keeps context.
2. **Mount / async-focus / open reconcile.** Once the conversation's own workspace is known (`conversationMeta.workspaceId`, from `conversations__get`) it follows or re-scopes as above if that differs from the focus. This fires only when the workspace is **known** — a not-yet-loaded conversation is left alone, which is the open-in-progress race guard.

Opening a conversation from within its own workspace doesn't change focus and matches, so it isn't cleared.

**The reconcile is the single guard.** `useChat` knows nothing about workspaces, so do not add a send-time backstop. A send in the moment before the conversation's workspace loads goes to the focused path and, for a conversation from elsewhere, is refused as unknown; it never runs in another workspace.

## Web Shell — Main-Area Views Beside the Docked Chat

`ShellLayout` renders left-nav | routed main area | docked chat (`ChatChrome`). Routed views under `/w/:slug/...` (e.g. `context/:convId`) render in the main-area slot **left of the chat** — their width is that chat-adjacent column, which shrinks as the chat docks or the window narrows. It is **not** the viewport width. How to lay that out (container queries, never viewport breakpoints) is in **`web/DESIGN.md`**, along with type, the opacity ramp, and the ambient-chrome default.

- **A routed element is reused across a param-only change.** The `/w/` prefix keeps `ChatChrome` mounted, so React Router keeps the same component instance alive when only the param changes (`context/:convId` A→B) — refs and state persist across the switch. On the param change you MUST (1) reset per-entity view state (selection/expansion and any `useRef` latch) and (2) cancel the previous entity's in-flight reads via an effect-cleanup flag. An unconditional `setState` in a stale `.then` lands entity A's data (its budget, its body) under entity B. See the load effect in `ContextInspectorPage.tsx`.
