# 0076. The kernel runs apps through declared interfaces, and knows none by name

- Status: Proposed
- Date: 2026-11-24
- Serves: secure RBAC; orchestrate remote MCP
- Supersedes: ADR-0075 (on acceptance)

## Context

The runtime is meant to be a generic engine for agents and the apps they use. The
analogy that fits is a game engine: it owns the loop, input, the rules of the world and
the renderer, and knows nothing about the game. Developers plug their game in through
the engine's interfaces, and the engine ships defaults so a new game runs on day one.

The runtime is not built that way. Conversations, tasks and files are kernel code: the
runtime constructs their stores, wires them into the run path and ships their screens.
Their boundaries are in-process interfaces, and an in-process interface leaks: a method
that returns a file path, a synchronous write the engine depends on, a component that
reads another's files instead of asking it. A boundary that does not serialize is one
module pretending to be two.

Three pressures make that untenable:

- **Scale.** Every runtime process assumes it is the only one on its data. Mutable
  records are files guarded by in-process locks, the scheduler fires each due task once
  per process, and caches, flows and limits live in one process (`src/api/AGENTS.md`,
  "Running more than one replica"). A deployment cannot add processes to carry more
  load, and conversations, tasks and files cannot grow independently of each other.
- **Composition.** Not every deployment wants every app. One runs scheduled work and no
  chat. Another uses the runtime only to host MCP apps and their screens. Each needs the
  same kernel with different apps, and none of those choices should change kernel code.
- **Replacement.** A large deployment brings its own storage and operations: its
  database, its object store, its queue. It replaces how a capability is implemented
  without forking the runtime.

ADR-0075 put records behind domain stores whose interfaces name no medium. That fixed
what an interface may say, but not that it serializes, and its storage-provider
registry is a second extension model beside MCP, which is how every other capability
enters the runtime. This decision replaces it.

## Decision

### The kernel and what plugs into it

**The kernel owns only what has to be in one place**:

- **Boot**: read configuration, load plugins in dependency order, check every contract
  version, and refuse a setup that cannot work.
- **Identity and scope**: who is acting and in which workspace. The kernel mints the
  scope and principal every call to a plugin carries; nothing else can.
- **The door**: whether a run may start, under whose authority, with what budget and
  tools, and which agent runtime executes it (ADR-0056).
- **Governance**: the workspace wall, consent, audit and metering, applied the same way
  to everything that plugs in.
- **Hosting**: reaching plugins over MCP, routing tool calls, and rendering what plugins
  declare in the web shell.

**Two kinds of thing plug in, each through the mechanism that fits it**:

- **Plugins** are capabilities that agents and people use: tools, screens, records.
  Conversations, tasks, files and every domain app are plugins, reached over MCP.
- **Providers** are infrastructure the kernel uses constantly and no agent calls: the
  work queue, pub/sub for change notification, leases. A provider has no
  tools and no screen. It is a configured implementation behind a kernel interface,
  local by default and replaceable for scale.

**The kernel never names a plugin in code.** It boots and serves with no plugin
enabled. A kernel feature that needs a capability names the contract, never the plugin
that implements it.

### Plugins are Agent Plugins

**A plugin is a directory in the Agent Plugins format (version 1.0.0)**: `plugin.json`
at its root, its MCP servers in `mcp.json`, its skills in `skills/`. NimbleBrain's own
declarations live under `extensions["ai.nimblebrain"]` and nowhere else, so the same
directory installs on other hosts, where only the parts the format defines are seen. A
manifest that fails the format's published schema, or an extension that fails its own,
is refused at load with the file and fields named.

**The plugin's servers are declared in `mcp.json`, as the format defines**:

```json
{ "mcpServers": {
  "conversations": { "type": "stdio", "command": "./bin/nb-conversations",
                     "args": ["--data-dir", "${PLUGIN_DATA}"] }
} }
```

**The extension declares capabilities, never trust**:

```json
"extensions": { "ai.nimblebrain": {
  "$schema": "https://schemas.nimblebrain.ai/plugin-extension/v1/plugin-extension.schema.json",
  "implements": [ { "contract": "ai.nimblebrain.conversations", "version": "1.0",
                    "server": "conversations" } ],
  "requires": [ { "contract": "ai.nimblebrain.files", "version": "1.0", "optional": true } ]
} }
```

- `implements` names each contract the plugin fulfils, at `major.minor`, and the
  `mcp.json` key of the one server that implements it.
- `requires` names contracts the plugin uses, never plugins. An `optional` requirement
  is used when some enabled plugin implements it; any other unmet requirement refuses
  boot.
- A server's placements and screens are its own published `ai.nimblebrain/host`
  metadata, served by the server itself. The extension carries no second placement
  format.
- Nothing in the extension grants trust, sets where a server runs, or switches a kernel
  feature. Those belong to the operator.

### Operators decide trust, presence and location

**The operator's configuration lists the plugins an instance runs**:

```json
"plugins": {
  "conversations": { "source": "builtin", "system": true },
  "tasks": false
}
```

- A plugin absent from the list and not a default is not loaded. `false` turns a
  default off.
- `system: true` is set only by the operator. A **system plugin** holds records the
  kernel relies on and sees data from other plugins by design, so a tenant can never
  add, remove or replace one from a catalog.
- `servers.<name>.url` reaches a plugin's server where it already runs instead of
  starting it. The same plugin runs locally as a process the runtime starts, or
  remotely at scale, with no change to the plugin.

**A system plugin may declare `stdio` servers, which the runtime starts.** This is the
one exception to ADR-0068's rule that the runtime only connects to servers: the
operator chose the plugin, and the default plugins must run with no other service
present. A plugin a tenant installs stays remote-only. A system plugin's processes
receive the scope and principal of each call and a minimal environment, never the
runtime's own.

### Catalogs decide reach, and the kernel keeps it

**A plugin reaches workspaces in one of three ways**, and trust and reach are separate
questions:

| | What it is | Who decides | In every workspace? |
|---|---|---|---|
| **Contract plugins** | implementations of a contract the kernel consumes (conversations, tasks, files) | the operator, in `plugins` | yes, as part of the platform; a workspace cannot remove one |
| **Catalog plugins** | tools, skills and screens a tenant or vendor offers to all of its workspaces | the operator, by attaching a catalog with a policy | as its catalog's policy says |
| **Workspace plugins** | connectors one workspace installs from any catalog or by URL | the workspace | no |

**The operator attaches catalogs, each with a policy**:

```json
"catalogs": [
  { "source": "https://catalog.example-vendor.com", "policy": "required" },
  { "source": "nimblebrain", "policy": "available" }
]
```

- `required`: every plugin in the catalog is installed in every workspace, including
  each workspace created later, and a workspace cannot remove it.
- `available`: the catalog's plugins are offered to install, as every catalog is
  today.
- Catalogs sit side by side: a vendor's own catalog beside NimbleBrain's catalog of
  business tools and any other.

**Policy decides presence, not authorization.** A required plugin's tools, skills and
screens are present in every workspace. A plugin that needs each person to sign in to
an outside account still asks each person; nobody is signed in on another's behalf. A
plugin that takes identity from the host context, as the kernel stamps it on every
call, works for everyone at once.

**The kernel keeps presence true.** At boot, when a workspace is created and when the
catalogs change, the kernel reconciles every workspace to its required plugins. No
script installs them and nothing has to remember to.

**Reach never changes trust.** A catalog plugin is a connector: the kernel connects to
it and never runs its code, every call carries the host context so the plugin walls by
workspace and person, and a catalog can neither implement a kernel contract nor make a
plugin a system plugin. Those come only from `plugins`.

**The operator's configuration holds the catalogs today.** A control plane that lets a
tenant attach and detach its own catalogs edits the same list.

### One server per capability, authorized by principal

**A plugin implements a contract with one MCP server.** The server exposes the contract's
**public tools**, what agents and people use, with its screen, and its **private tools**,
what the kernel uses to save and read what it depends on. Which tools are private is the
contract's decision, not the plugin's.

**The server enforces who may call what.** Every call carries an authenticated context
with a scope (workspace, owner) and a **principal**: `host`, the runtime itself, or
`person`, a user directly or through an agent. Public tools accept either. Private tools
accept only `host`; any other caller is refused (`forbidden`) and nothing changes.

- **The runtime sets the principal on every call and discards any a caller supplied.**
  Only kernel code presents `host`. An agent's tool call, an MCP App's `tools/call`
  through the bridge, and a request at the MCP door all present `person`, whatever they
  name and whatever `_meta` they carry, so no agent and no app can rewrite what the
  kernel records.
- **The runtime never offers private tools to agents** and never lists them at its MCP
  door. That keeps them out of view; the server's refusal is the boundary.
- **The context travels the same way to every plugin server**: the host context, one shared
  spec for every contract (`contracts/host-context/CONTEXT.md`, its schema at
  `https://schemas.nimblebrain.ai/host-context/v1/host-context.schema.json`). It is the object
  at `params._meta["ai.nimblebrain/context"]`: `principal`, and `workspaceId`, `ownerId` and
  `conversationId` where the call has them. The runtime stamps it on every request and
  overwrites any a caller supplied.
- **A server believes the context only from an authenticated host transport**: stdio by
  construction, HTTP by a credential the operator issues to the host for that server. Where
  the transport verified a dimension itself (an edge's verified tenant and workspace), the
  verified value wins and a context that contradicts it is refused (`context_mismatch`). A
  server serving several tenants walls by the transport-verified tenant as well.

### Every capability the kernel consumes is a contract

**A contract is versioned, language-neutral and independent of any implementation**:

- one JSON document per version, `contract.json`: its permanent reverse-DNS name
  (`contract`, the name `implements[].contract` uses), its
  version, its cardinality, its tools with their visibility (public or private), each
  tool's input and output JSON Schema (draft 2020-12, bundled in `$defs`), and its closed
  list of errors;
- `CONTRACT.md`: the normative rules for scope and principal, ordering, idempotency,
  errors and versioning;
- a conformance runner that speaks only MCP to an implementation.

An implementation in any language is valid when it passes the runner. The runner also
checks a host's agent-facing surface, where the public tools must be served and the
private tools absent. Generated types
for a language are packaging, never the contract.

- **Identity is not location.** The name (`ai.nimblebrain.conversations`) is permanent.
  Where the document lives is its `$id`, stated in the document, never derived from the
  name. Under NimbleBrain's domain it is
  `https://schemas.nimblebrain.ai/contracts/<short-name>/v<major>/contract.json` (this
  one is `…/contracts/conversations/v1/contract.json`); a third party's contract lives on
  its own domain in the same shape. The URL names the major; a minor that only adds is
  served in place.
- **Versions are `major.minor`.** The same major is compatible; a higher minor only
  adds. A consumer states the minor it needs, and the kernel refuses an implementation
  below it.
- **Cardinality belongs to the contract.** A `singleton` contract has at most one
  enabled implementation per instance; an `additive` one may have many. Two enabled
  plugins implementing a singleton contract refuse boot.
- **Every contract call carries scope and principal** (workspace, owner where a record
  has one, and `host` or `person`), minted by the kernel from the request and never
  from tool input. A record outside scope is indistinguishable from one that does not
  exist.
- **The interface names no medium.** No path, handle, offset, query or bucket key
  crosses a contract. Order is assigned by the implementation, never by a caller's
  clock or lock. Lists page by opaque cursor.

**Chat is a kernel feature that consumes the conversations contract.** It is on exactly
when an enabled plugin's server implements `ai.nimblebrain.conversations` at a
supported version. The kernel saves and reads each turn through that server's private
tools, and people and agents use its public tools and screen. Turning that plugin off turns chat off: its routes answer that chat is
disabled, and the shell shows no chat. A run that has no conversation, such as a
scheduled task, needs none.

### Providers carry the infrastructure

**Each provider is a kernel interface with a local implementation and replaceable
ones**, chosen in configuration, held to a conformance suite of its own:

- **Work queue**: run requests are enqueued with an idempotency key and a not-before
  time, and claimed with a lease and fencing token. Triggering (a schedule or an event
  deciding a run is due) only enqueues; the door executes whatever a worker claims.
- **Pub/sub**: change notifications that reach every runtime process.
- **Leases**: claims on work that must happen once.

Locally each is in-process or on the filesystem. At scale each is a shared service. A
provider declares whether it is safe for more than one process, and boot refuses a
topology it cannot serve.

**File bytes are not a provider.** The files implementation owns its bytes and its storage,
private to it, and moves bytes to and from the kernel by short-lived URLs it issues (the files
contract). The kernel reads and writes no file storage of its own.

**With shared providers and system plugins reached by URL, runtime processes are
interchangeable workers.** Conversations, tasks and files each scale as one server of
their own, and the runtime scales by adding processes.

### Defaults ship in the box

`npx nimblebrain` runs the default system plugins (conversations, tasks, files) and the
local providers with no configuration, on the local filesystem, behaving as the runtime
does today.

### The repository follows the roles

```
contracts/          language-neutral contracts: conversations/, tasks/, files/,
                    plugin-extension/, host/, and host-context/, the call context
                    every contract shares
packages/           independent artifacts
  server-sdk/       what a plugin server builds on: reading the host context, tool errors,
                    the principal rule, reading a contract document
  conversations/    a plugin: one MCP server;  tasks/, files/ likewise
  providers-*/      replaceable provider implementations
  cli/              npx nimblebrain
src/                the kernel, one folder per job
  boot/ identity/ door/ engine/ execution/ history/ prompt/ model/
  governance/ host/ plugins/ providers/ api/ observability/
web/                the shell: renders what plugins declare, knows no plugin by name
```

**Dependencies point one way, and a check enforces them**: contracts depend on nothing;
the server SDK and plugins depend on contracts; the kernel depends on contracts and its
providers. The kernel never imports a plugin, and a plugin never imports the kernel. A
folder is named for its role, never for a domain noun that appears in several roles:
how a conversation is stored belongs to its plugin, what a conversation is belongs to
its contract, and how a turn turns events into a model's context belongs to the
kernel's `history/`.

## Consequences

- A deployment composes the runtime in configuration: chat and scheduled work,
  scheduled work alone, or an MCP app host with neither. Replacing how a capability is
  stored or run is configuring a plugin or a provider, not changing the kernel.
- Every plugin boundary serializes, so an interface can no longer leak a path, a handle
  or an in-process assumption. What crosses it is what its schema allows.
- The runtime can run as many processes once the remaining per-process assumptions
  (caches, flows, locks, limits) move onto shared providers. This decision gives them
  their primitives; each still has to be moved.
- The kernel gains a lifecycle: starting system plugins, checking contracts, ordering
  by dependency, and surviving a plugin that is down. A system plugin whose server does
  not start at boot refuses the boot, like any setup that cannot work. A plugin that
  cannot be reached after boot makes its own capabilities unavailable until it is back;
  it never stops a running runtime.
- Every call to a system plugin is an MCP call. Locally it reaches a process on the
  same machine; at scale it crosses the network to work that is a file write today.
  Batching a turn's writes keeps the calls per turn few.
- Each system plugin runs as one process or one service, and its screen and tools read
  the same records the kernel writes, in the same server.
- The boundary between agents and the kernel's records is each server's authorization,
  so every implementation must enforce the principal rule; the conformance runner
  checks that each private tool refuses a `person`.
- Every published contract is an interface maintained for every implementation built on
  it. Contracts are written for what the kernel consumes and what someone will replace,
  and nothing else.
- A tenant or vendor offers its own tools to all of its workspaces by attaching a
  catalog with `required`; the kernel's reconcile keeps them present. A policy that
  installs everywhere but lets a workspace remove a plugin is a later addition, made
  when someone needs it.
- Moving to this layout is incremental: conversations first, then tasks with the work
  queue, then files. The work happens on a dedicated branch and reaches
  `main` when each step is complete and passes its conformance suites.

## Alternatives considered

- **Policy on each catalog entry instead of each catalog.** Rejected for now: a catalog
  is what a tenant or vendor curates for one purpose, so the policy belongs with it. An
  entry-level override is added if a catalog ever needs to mix.
- **Installing required plugins with a script or an admin action per workspace.**
  Rejected: a workspace created later, or one a script missed, would lack them. Presence
  is an invariant the kernel keeps by reconciling.
- **In-process domain stores with a storage-provider registry (ADR-0075).** Superseded:
  the boundary does not serialize, so it can leak, and the registry is a second
  extension model beside MCP for capabilities.
- **Infrastructure as MCP plugins too.** Rejected: a queue, pub/sub and leases
  have no tools and no screen, are used by the kernel alone at high frequency, and need
  semantics (long-polling, acknowledgement) a tool call carries poorly.
- **A plain HTTP contract for records.** Rejected: MCP carries the same semantics in tool
  schemas, and a second protocol splits how capabilities enter the runtime.
- **Two servers per plugin (an app and a records server).** Rejected: the boundary
  belongs in the server's authorization, not in which server a caller can reach. Two
  servers doubled the processes, and forced the app to reach its records across a
  second connection.
- **Private tools protected only by hiding them from agents.** Rejected: hiding depends
  on the runtime filtering every path. The server refuses a private tool to any caller
  but `host`, so a path that forgets to filter still reaches nothing.
- **System plugins installable by tenants.** Rejected: a system plugin sees every
  plugin's data.
- **`.claude-plugin/plugin.json` as the manifest.** Rejected: it is one host's format.
  The Agent Plugins format is the portable one, and NimbleBrain's fields fit its
  extension namespace.
- **A URL or URN as the contract id.** Rejected: a URL ties identity to a location, and
  the URN scheme identifies published artifacts, not interfaces. A reverse-DNS name
  matches how this ecosystem names extension points, and the document states its own
  location.
- **Keep conversations, tasks and files in the kernel.** Rejected: a deployment that
  wants scheduled work without chat, its own conversation storage, or more capacity
  for one capability than another would need a different kernel.
