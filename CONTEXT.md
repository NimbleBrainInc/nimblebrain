# CONTEXT — NimbleBrain runtime

The domain model for `nimblebrain/code`: what the nouns mean and the invariants
that hold. This is the *what is true* reference. For *how to work in the repo*
see `AGENTS.md`; for *why a thing is the way it is* see the decision log in
`adr/`; for the codebase map and API reference see `README.md`.

> Authoring rule: this file is present-tense and describes the current system.
> History and rationale live in `adr/` and git, not here.

## What NimbleBrain OSS is — the three golden rules

NimbleBrain is a generic agent runtime with the smallest kernel that does three
things. Everything in the kernel serves one of these; if a capability doesn't,
it belongs in a bundle, a Synapse app, or upstream MCP — not the runtime.

1. **Manage skills** — discover, compose, and apply `SKILL.md`-format guidance
   into the agent's prompt without busting the prompt cache. *(Domain terms:
   skill, role/channel, the two planes. ADRs: batch 2 / backlog.)*
2. **Orchestrate over remote MCP servers** — treat every tool/resource provider
   (mpak bundle, remote MCP, Composio, Synapse app) as an interchangeable MCP
   source through one boundary, and keep those connections healthy. *(Domain
   terms: source, connection, recovery. ADRs: 0005 + batch 2.)*
3. **Provide secure RBAC** — isolate everything behind the workspace boundary,
   private to its owner by default, with no ambient cross-scope authority.
   *(Domain terms below; ADRs 0001–0006 — this is the fully-worked domain.)*

## Domain glossary

### Workspace
The authorization boundary (ADR-0001). A session reaches exactly **one**
workspace plus the caller's identity tools — never a union across workspaces. A
non-personal workspace has an opaque id `ws_<16-hex>`, members, and roles
(`admin` | `member`).

### Personal workspace
A user's own workspace, `ws_user_<userId>`, sole-owned. It is a workspace like
any other — "everything is workspace-bound" holds with no "no-workspace" void.
Home = your personal workspace.

### Owner
The authenticated principal a primitive belongs to. Stored as an `<ownerId>`
sub-partition in the path (ADR-0003), which makes owner-privacy structural.

### Visibility
A mutable field on a primitive, `private` (default, fail-closed) or `shared`
(ADR-0004). v1 is private-only; `shared` is groundwork, not yet read. `shared`
never crosses the workspace wall — it means "to this workspace," never beyond.

### The wall
The workspace boundary, enforced **structurally** (the storage path, ADR-0003)
and **at dispatch** (`routeToolCall`, ADR-0005). Reaching another workspace is
**denied, not gated**. The one sanctioned crossing is a personal-connector grant
(ADR-0006, proposed).

### Identity door / tool namespacing
A tool name's shape is its scope (ADR-0005). **Workspace tools** are
`ws_<id>-<source>__<tool>` and dispatch only for the session's workspace.
**Identity tools** (kernel sources — conversations, files, automations) are bare
`<source>__<tool>`, owned by the user, outside any workspace.

### Primitive (conversation / file / automation)
Workspace-owned, stored at `workspaces/<wsId>/<primitive>/<ownerId>/`
(ADR-0003). The path is authoritative; `workspaceId`/`ownerId` on the record are
denormalised. Private to the owner by default (ADR-0004). **Active use**
(resuming a conversation, running an automation, reaching the workspace's tools)
requires **current membership** of the primitive's workspace — checked at session
establishment, so offboarding revokes reach; **reading** your own authored
primitive stays owner-gated (ADR-0007).

### File
A workspace-owned primitive with a globally-unique id (`fl_<24 hex>`). Addressed
by the bare id: the server resolves its workspace from the id within the caller's
own owner partitions, via the `FileLocator` (ADR-0002). The owner partition is
both the gate and the search scope.

### Source / Connection *(golden rule #2 — glossary stub)*
An MCP source is any tool/resource provider behind the MCP boundary; a
connection is the supervised transport to a remote one. Recovery splits
connection-health from application-outcome classification. *Full terms +
decisions land with the MCP-orchestration ADR batch.*

### Skill *(golden rule #1 — glossary stub)*
A `SKILL.md`-format unit of guidance; its role determines its prompt channel,
and it loads without mutating the cached prompt prefix. *Full terms + decisions
land with the skills ADR batch.*

## Decisions

The decision log is `adr/`. Foundational (secure RBAC):

- [0001](adr/0001-workspace-is-the-boundary-not-identity.md) — the workspace is the boundary, not the identity
- [0002](adr/0002-files-resolve-by-bare-id.md) — files resolve by bare id via a workspace locator
- [0003](adr/0003-primitives-are-workspace-owned-and-path-authoritative.md) — primitives are workspace-owned and path-authoritative
- [0004](adr/0004-private-by-default-visibility-is-a-field.md) — private by default; visibility is a mutable field
- [0005](adr/0005-no-cross-workspace-reach-tool-shape-is-scope.md) — no cross-workspace reach; a tool name's shape is its scope
- [0006](adr/0006-personal-connector-use-requires-a-grant.md) — personal-connector use in a shared workspace requires a grant *(proposed)*
