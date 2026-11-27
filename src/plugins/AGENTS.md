# Plugins

Scope: `src/plugins/`. Reading Agent Plugins, the `ai.nimblebrain` extension, the contract
registry, and resolving the plugins an operator configures (ADR-0068, ADR-0076).

## One manifest format

- **A catalog plugin and a system plugin are the same format.** An Agent Plugins 1.0.0
  directory: root `plugin.json`, every server in `mcp.json`, skills in
  `skills/<name>/SKILL.md`. NimbleBrain's fields live only under
  `extensions["ai.nimblebrain"]`, so the directory installs unchanged on other hosts.
- **`manifest.ts` is the one reader of `plugin.json` and the extension.** Code that needs a
  manifest field calls it; never parse `extensions["ai.nimblebrain"]` anywhere else
  (`src/skills/connector-skill-resolver.ts` reads its catalog plugins through it).
  - `parsePluginManifest` is strict, for a plugin the operator configured: the format's
    schemas (vendored in `schemas/` here, never fetched), the format's prose rules
    (one-token `command`, `cwd` inside its root, HTTPS off loopback, `${PLUGIN_ROOT}` /
    `${PLUGIN_DATA}` expanded only in `args`, `env` and `cwd`), and the extension's schema.
    Every problem names the plugin, the file and the field. An unknown top-level manifest
    field is a warning, because the format says report and ignore.
  - `nimblebrainExtension` is lenient, for a manifest a pinned catalog vouches for: it
    drops a malformed field instead of failing the read.
- **The vendored `schemas/agent-plugins-1.0.0-*.json` are the format's, byte for byte.**
  Replace them only with the published versions; never edit them.

## The extension is additive and published

- **`extension.ts` (TypeBox) is the source; the repository's
  `schemas/plugin-extension/v1/plugin-extension.schema.json` is the published form**, served
  at its `$id`, and what the loader validates. Edit the TypeBox, run
  `bun run emit:plugin-extension`; `bun run check:plugin-extension` (in `verify:static`)
  fails on drift.
- **v1 only adds.** Every field is optional and objects are open, so what the catalog emits
  today (`servers`, `conversationStarters`, and `nimblebrainOnly` in its AI Catalog) stays
  valid. A rename or removal is a new major directory (`v2/`), never an edit.
- **Each fact has one home.** How a server starts or is reached: `mcp.json`. Its registry
  name: the extension's `servers` (key to name). Its auth and placements: that registry
  entry's `_meta`, or the server's own `ai.nimblebrain/host`, never the extension. Never
  declare a server inside the extension: the format forbids MCP configuration in
  `plugin.json`.
- **`implements[].server` is an `mcp.json` key.** One server implements a contract, serving
  its public and private tools. It is never a key the extension's `servers` alone names:
  such a server is reached through its registry entry at install (a brokered session URL),
  so the kernel has no address for it at boot. The reader refuses any other key.
- **The extension declares capabilities, never trust.** Nothing in it makes a plugin a
  system plugin, sets where a server runs, or switches a kernel feature.

## Defaults ship in the box

- **The default plugins are configuration, in `src/config/plugins.ts` (`DEFAULT_PLUGINS`)**: the
  built-in conversations plugin (chat), the built-in tasks plugin (scheduled and unattended
  work) and the built-in files plugin (files and attachments), each a system plugin. `withDefaultPlugins` lays the operator's `plugins` block over
  them: an entry of a default's name replaces it, and `false` turns it off. With no block the
  instance runs the defaults exactly as an explicit entry would.
- **A system plugin's skills join the core pool** while it is enabled: every
  `<root>/skills/<name>/SKILL.md` (`loadSystemPluginSkills`), marked vendored. The tasks plugin's
  authoring guide (`task-authoring`, bound to `tasks__*`) arrives this way; the plugin also serves
  the same body as its server instructions for MCP clients that load no skills.
- **Binding another implementation of a singleton contract turns the default off.** Two
  enabled implementations refuse boot, so an operator writes `"conversations": false` beside
  their own plugin's entry.

## System is an operator decision

- **Only `nimblebrain.json` `plugins.<name>.system` makes a system plugin**
  (`src/config/plugins.ts`). No manifest field can.
- **Only a system plugin's `stdio` servers are started**; any other plugin's servers are
  reached by URL (ADR-0076, the one exception to ADR-0068's remote-only rule). An operator's
  `servers.<key>.url` reaches a server where it already runs instead.

## Contracts and the kernel

- **`contracts.ts` reads `schemas/contracts/<name>/v<major>/contract.json` and names no
  contract in code.** Matched by the document's `contract` name. Version: same major, minor
  at least the document's. Cardinality: a `singleton` has at most one enabled
  implementation. A document under a `v<major>` its version does not state is refused.
- **A binding carries the contract's markings**, projected from the document: its private tools
  (`visibility`), the tools refused unattended (`unattended: "refused"`, every private tool too),
  the public tools that write (annotated `readOnlyHint: false`, announced to the caller's views
  after a successful call),
  the tools that take a run grant (`grant: true`, refused at load on any other than a public tool
  refused unattended), and the version the kernel consumes (`hostVersion`, sent as `version` on
  a private call). Which tools carry which marking is the contract's decision, never the
  plugin's.
- **The kernel never names a plugin.** A kernel feature that needs a capability names the
  contract and asks for its binding; nothing here branches on a plugin's name.
- **`checkConfiguredPlugins` is the boot hook.** It resolves the defaults with the operator's
  block over them. With every plugin turned off it reads nothing (not even the contract
  documents). Otherwise it validates, logs the resolved set, and throws naming every error.
  It starts nothing; the runtime starts the bound servers from what it returns.

## Binding a contract's server

- **`bound-servers.ts` starts every binding's server and holds it by contract.** The kernel
  looks a server up by contract id (`BoundServer` per contract), never by plugin name. A
  stdio server is started from `mcp.json` with `${PLUGIN_DATA}` at
  `<workDir>/plugin-data/<name>` (created before the start), the SDK's minimal environment
  plus the server's own `env`, then the host configuration its contract has the host pass
  (`ServerEnvironments`, by contract), never the runtime's. A binding whose server the operator placed
  at a `url` is refused at boot until the kernel holds a host credential for it.
- **One connection per bound server, one `McpSource` (mode `plugin`).** Agents (the
  ToolRouter), the `/mcp/<wsId>` door and the app bridge reach the server through that
  source; the kernel's contract client (`BoundServer.call`) uses the same connection. Every
  bound server's source is a platform source, so its tools, resources and placements reach
  the shell the way an in-process app's do, and shutdown stops it once with them.
- **A bound server's screen is placed from its own metadata.** The server answers its
  handshake (`initialize`, or `server/discover` on the 2026-07-28 revision) with
  `_meta["ai.nimblebrain/host"]` (`schemas/host/v1/host.schema.json`); `McpSource` keeps that
  block for a plugin's server, and `getPlacements()` returns its placements through
  `sanitizePlacements`, the check every connector's placements pass. No placement is
  hard-coded in the kernel.
- **Facts only the host knows are laid over a bound server's results** (`ResultOverlays`, by
  contract, passed to `startBoundServers`): the runtime overlays `active` on every relayed
  conversations `list`. An overlay also sees each person's call as it passes, which is where
  the runtime records a files `create` made in a run and reports a tasks `create`
  (`automation.created`); the kernel's own `host` calls never reach one. The overlay renders the text content again from the overlaid result.
- **The kernel announces its own writes.** A write through the contract store fires the
  source's `notifications/resources/list_changed` to its subscribers for the owner, as an
  in-process app's server would, so the owner's views refresh.
- **The source name is the kernel's, keyed by contract** (`CONTRACT_SOURCE_NAMES` in
  `src/tools/identity-sources.ts`, beside the identity-source names it routes). So
  `conversations__*` is the namespace whichever plugin implements the contract; the
  implementation's `mcp.json` key only says which server to launch. The contract document
  carries no host name: how a host exposes the public tools is the host's (`CONTRACT.md` §5).
  `ai.nimblebrain.tasks` is `tasks`, `ai.nimblebrain.files` is `files`.
- **The host context is stamped in one place: the transport's `send`.** Every request to a
  bound server passes it, after every other `_meta` merge, and it overwrites
  `params._meta["ai.nimblebrain/context"]` (`contracts/host-context/CONTEXT.md`). Never set
  the context anywhere else, and never build a second transport to a bound server.
- **The principal comes from the call path, not from data.** `host` only inside
  `BoundServer.call` and `BoundServer.watch`, whose scope lives in a module-private
  `AsyncLocalStorage` nothing exports (a host scope may name the turn's conversation or the
  run it is made for); every other request presents `person`, with the workspace, signed-in
  identity, turn conversation and run id from the request context. Do not export
  that scope or add a second way to present `host`.
- **The send stamps `unattended` and `grant` from the same facts** (`contextFor`). A `person`
  request made inside an unattended run (`RequestContext.unattended`) carries `unattended: true`.
  A `person` `tools/call` to a grant-marked tool, with a workspace and an owner and outside any
  run, carries the host's run grant for them, signed by the runtime's grant key
  (`src/runtime/run-grant.ts`). A host call, any other tool, and an unattended call never carry
  one, so no run obtains authority for another; a value a caller put in `_meta` is overwritten.
- **Refused-unattended tools are refused by the source** (`refusedUnattended`): a call made
  inside an unattended run to one answers `unattended_refused` before the server sees it, and
  `Runtime.listRunTools` leaves them out of a run's tools (`Runtime.isUnattendedRefused`, which
  the unattended dispatch asks too). The server's own refusal is the boundary.
- **A change hint is watched as `host`** (`BoundServer.watch`): a `subscriptions/listen` of its
  own on a 2026-07-28 connection (one per workspace, since the server answers a subscription
  only for the workspace in its context), `resources/subscribe` on a 2025-era one. The source's
  own listen stream carries no contract URI. A restarted server holds no subscription, so the
  watcher watches again when `BoundServer.connection()` changes.
- **A purge calls `delete_workspace` on every binding whose contract marks it private**
  (`BoundServer.privateTools`), never on a binding named in code (`src/workspace/AGENTS.md`).
- **Private tools are hidden by the source** (`hiddenTools`, from the binding's
  `privateTools`): left out of `tools/list` and so of every agent listing and the door, and
  refused by `execute` and `startToolAsTask`. That is tidiness; the server's `forbidden` is
  the boundary.
- **Lifecycle.** The bound servers start together, so boot waits for the slowest, not the
  sum. A server that does not start refuses the boot, naming the contract, plugin
  and server, and the ones that started are stopped. One that exits is restarted on the next call that needs it (the kernel's own
  call, or an agent's through `McpSource` recovery); a call in flight when it exited is not
  retried. Shutdown settles queued writes, then stops it; a stopped server is never
  restarted.
- **A contract that moves bytes by URL is fetched through the SSRF-guarded fetch**
  (`createSsrfGuardedFetch`, `src/tools/ssrf-guarded-fetch.ts`) with redirects refused, against
  the binding's authorised destinations: its own server's origin, a per-binding
  `transferOrigins` list in host configuration, and loopback for a stdio binding
  (`contracts/files/CONTRACT.md` §7, §10): `BoundServer.transferDestinations`, with the
  plugin's `transferOrigins` (`nimblebrain.json`, each an http or https origin, normalised at
  boot). The runtime binds only a server it starts over stdio, so today that is loopback and
  the listed origins. The client is `src/files/transfer.ts` (`src/files/AGENTS.md`).
- **A contract can refuse calls the host knows to refuse** (`CallGuard`, by contract, passed to
  `startBoundServers`): checked on the kernel's own call and, through the source's
  `refuseCall`, on every person call. The files binding refuses every call but
  `delete_workspace` for a tombstoned workspace.
