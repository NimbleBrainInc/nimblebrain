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
it belongs in an MCP server, a Synapse app, or upstream MCP — not the runtime.

1. **Manage skills** — discover, compose, and apply `SKILL.md`-format guidance
   into the agent's prompt without busting the prompt cache. *(Domain terms:
   skill, role/channel, catalog, provenance. ADRs 0009–0019.)*
2. **Orchestrate over remote MCP servers** — treat every tool/resource provider
   (a directly-addressed server, a gateway-brokered one, a Synapse app) as an
   interchangeable MCP source through one boundary, and keep those connections
   healthy. The runtime connects; it does not acquire, verify, or execute a
   server's code. *(Domain terms: source, connection, brokered connector, task
   augmentation. ADRs 0005, 0020–0032.)*
3. **Provide secure RBAC** — isolate everything behind the workspace boundary,
   private to its owner by default, with no ambient cross-scope authority.
   *(Domain terms below; ADRs 0001–0008.)*

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
(ADR-0006), which fails closed with `ConnectorGrantDenied`.

### Identity door / tool namespacing
A tool name's shape is its scope (ADR-0005). **Workspace tools** are bare
`<source>__<tool>` — the workspace is not in the name, so another one cannot be
addressed. **Personal connectors** carry a reserved `my_` marker
(`my_gmail__send`). **Identity tools** (kernel sources — conversations, files,
automations) are bare too, owned by the user, outside any workspace. The source
segment alone decides which door a call takes.

**Two senses of "owned" meet here.** A kernel source is *identity*-owned — the
tool is the user's and takes the identity door in every workspace. The data it
reaches is *workspace*-owned — each conversation, file, and automation sits in
one workspace's partition (ADR-0003). Identity-owned door, workspace-owned
data; both are true at once, and the wall is the second one.

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

### Notification
A fact a connector recorded that nobody asked for, pulled from an outbox the
server declares and held in a workspace-owned inbox at
`workspaces/<wsId>/notifications/` (ADR-0003, ADR-0008). Unlike the other
primitives it has **no owner sub-partition**: it is authored by a connector, not
a user, so any member who can reach that connector's tools can read it. The
runtime stamps `source`, `workspaceId`, `receivedAt` and a per-workspace
monotonic `seq`; a server can set none of them. The runtime reads the envelope
fields it defined and never the server's opaque `data`.

### Source
Any tool/resource provider behind the MCP boundary. Every source is one
`McpSource` over one transport union (ADR-0022): a remote server over HTTPS, or
one of the kernel's own capabilities — conversations, files, automations,
skills — served by a real MCP server on an in-memory linked-pair transport. The
platform's own capabilities are MCP servers to themselves, so nothing above the
source can tell them apart.

The runtime **connects**; it does not acquire, verify, or execute a server's
code (ADR-0020). A persisted reference is a URL plus how to reach it and who it
speaks as, and discovery is a catalog of published `ServerDetail` entries behind
one source interface.

The transport arm is also a trust boundary: in-memory means the bytes never left
the process, which is what host-owned `_meta` markers are conditioned on
(ADR-0014, ADR-0024).

### Connection
The supervised link to a remote source, carrying the
`(serverName, workspaceId, principalId, ref)` tuple. Two disjoint loops watch it
(ADR-0028): **process liveness** (`HealthMonitor` — is the transport up? restart
it, indefinitely, because an outage self-heals) and **credential liveness**
(`ConnectionRevalidator` — did the upstream authorization lapse? flip to
reauth-required and stop, because only a human can fix it). Neither loop
concludes anything about the other's question.

A connection's secret is named, never inlined: persisted state carries a
credential reference resolved through one store (ADR-0027).

A connection records **state, not the handle**. The `McpSource` lives in the
workspace's registry, addressed by the `(workspaceId, serverName)` the
connection is already keyed on, and a consumer that needs it resolves it there
each time. `running` therefore means one thing — the credential is good and a
source is registered — and a reconnect, which replaces the source object
wholesale, cannot leave a second reference pointing at the predecessor.

### Brokered connector
A connector whose auth *and* hosted MCP session come from a third party.
`ManagedConnectorProvider` is the seam, and it owns the **auth-and-session broker
role only — never invocation** (ADR-0026); the session it returns is an ordinary
remote source. `dcr` and `static` are runtime-native and stay outside the seam.

### Task augmentation
How a long-running tool call is made without holding a socket open. A server
marks a tool `execution.taskSupport`; the runtime attaches a task, polls the
stream, and can cancel (ADR-0029). The retry policy inverts with it: an inline
call is re-issued once on a transport error, and a task call is **never**
retried — it has already created server-side state, so replaying it would
duplicate the side effect.

### Skill
A unit of guidance in the Agent Skills format. The file is the standard,
unmodified, with the runtime's own configuration nested under
`metadata.nimblebrain` and validated by one schema (ADR-0009). A skill comes off
the filesystem, off an MCP server's `skill://…/SKILL.md` resource (a peer, not a
lesser kind — ADR-0011), or from a curated connector overlay (ADR-0013).

### Role / channel
A skill's declared `loading-strategy`, and the prompt channel that follows from
it (ADR-0010). `always` composes into the system prompt every turn. `dynamic`
reaches the model by tool-affinity (selected once at turn start), by an explicit
trigger phrase (matched per message, the deterministic must-fire channel), or —
carrying neither — by the catalog. The sets are disjoint by construction, so a
skill is never in two channels, and one predicate answers "how would this skill
load?" for every read surface.

### Catalog
The model-facing index of activatable skills: name and description only, sorted
and deduplicated (ADR-0015). It lists what **can** be activated and never what
**is** loaded, so its bytes move only on install and authoring events and the
cached prompt prefix holds.

### Provenance
Who authored a skill. `chat`, `admin`, `connector`, and `import` are audit facts
written to disk. `vendored` is not: it is the trust marker for platform-shipped
skills, stamped in memory at load on the platform's own source-tree directories
and absent from the on-disk schema, so a file cannot forge it (ADR-0012).

## Decisions

The decision log is `adr/`. Foundational (secure RBAC):

- [0001](adr/0001-workspace-is-the-boundary-not-identity.md) — the workspace is the boundary, not the identity
- [0002](adr/0002-files-resolve-by-bare-id.md) — files resolve by bare id via a workspace locator
- [0003](adr/0003-primitives-are-workspace-owned-and-path-authoritative.md) — primitives are workspace-owned and path-authoritative
- [0004](adr/0004-private-by-default-visibility-is-a-field.md) — private by default; visibility is a mutable field
- [0005](adr/0005-no-cross-workspace-reach-tool-shape-is-scope.md) — no cross-workspace reach; a tool name's shape is its scope
- [0006](adr/0006-personal-connector-use-requires-a-grant.md) — personal-connector use in a shared workspace requires a grant
- [0007](adr/0007-offboarding-revokes-active-use.md) — offboarding revokes active use; ownership is necessary, not sufficient
- [0008](adr/0008-notifications-are-pulled-and-routed-by-the-operator.md) — notifications are pulled into a workspace inbox and routed by the operator

Manage skills:

- [0009](adr/0009-skills-are-the-agent-skills-standard-plus-a-nested-runtime-block.md) — a skill is the Agent Skills standard plus one nested runtime block
- [0010](adr/0010-role-decides-the-channel.md) — a skill's role decides its prompt channel
- [0011](adr/0011-a-server-published-skill-is-a-peer-of-a-filesystem-skill.md) — a server-published skill is a peer of a filesystem skill
- [0012](adr/0012-vendored-provenance-is-loader-stamped.md) — vendored provenance is loader-stamped, never on disk
- [0013](adr/0013-connector-overlays-are-curated-pinned-and-reconciled-at-boot.md) — connector overlays: one curated repo, pinned, content-addressed, reconciled at boot
- [0014](adr/0014-skill-markers-are-host-owned-meta.md) — skill activation and suppression markers are host-owned `_meta`
- [0015](adr/0015-the-catalog-lists-what-can-be-activated.md) — the catalog lists what can be activated, never what is loaded
- [0016](adr/0016-binding-home-for-connector-and-skill.md) — *(proposed)* where the connector↔skill binding lives
- [0017](adr/0017-retiring-the-trigger-matcher.md) — *(proposed)* whether the trigger matcher retires
- [0018](adr/0018-skill-channels-and-the-cache-breakpoints.md) — *(proposed)* where each skill channel sits relative to the cache breakpoints
- [0019](adr/0019-scope-precedence-when-two-skills-share-a-name.md) — *(proposed)* scope precedence when two skills share a name

Orchestrate over remote MCP:

- [0020](adr/0020-the-runtime-connects-it-does-not-acquire.md) — the runtime orchestrates over remote MCP; it does not acquire or execute a server's code
- [0021](adr/0021-one-run-start-door.md) — one run-start door; delegation is not a kernel capability
- [0022](adr/0022-one-source-type-over-one-transport-union.md) — every source is one `McpSource` over one transport union
- [0023](adr/0023-client-capability-advertisement.md) — the client advertises `tasks` and `extensions`, and nothing it does not serve
- [0024](adr/0024-private-extensions-live-under-one-reverse-dns-namespace.md) — private extensions live under `ai.nimblebrain/*`, and reuse the spec's schemas
- [0025](adr/0025-hook-declarations-come-from-the-operator-trusted-catalog.md) — hook declarations come from operator-trusted catalog metadata
- [0026](adr/0026-a-brokered-provider-owns-auth-and-session-only.md) — a brokered provider owns auth-and-session only, never invocation
- [0027](adr/0027-persisted-state-names-the-credential-not-the-value.md) — persisted state names *what* credential it needs, never *where* the value lives
- [0028](adr/0028-two-disjoint-health-loops.md) — two disjoint health loops: process liveness and credential liveness
- [0029](adr/0029-long-running-tools-are-task-augmented-and-never-retried.md) — long-running tools are task-augmented; task calls never retry
- [0030](adr/0030-consuming-resource-update-notifications.md) — *(proposed)* how far resource-update consumption generalizes
- [0031](adr/0031-which-tool-annotations-the-consent-model-reads.md) — *(proposed)* which spec `ToolAnnotations` the consent model reads
- [0032](adr/0032-provider-typed-ref-blocks-on-persisted-state.md) — *(proposed)* the provider-typed blocks on persisted connector state
