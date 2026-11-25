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
- **A binding carries the contract's private tool names**, projected from the document's
  `tools[].visibility`, so the code that registers the server never offers them to agents.
  Which tools are private is the contract's decision, never the plugin's.
- **The kernel never names a plugin.** A kernel feature that needs a capability names the
  contract and asks for its binding; nothing here branches on a plugin's name.
- **`checkConfiguredPlugins` is the boot hook.** With no plugin enabled it reads nothing
  (not even the contract documents), so an instance without a `plugins` block boots as
  before. With plugins it validates, logs the resolved set, and throws naming every error.
  It starts nothing; the runtime starts the bound servers from what it returns.

## Binding a contract's server

- **`bound-servers.ts` starts every binding's server and holds it by contract.** The kernel
  looks a server up by contract id (`BoundServer` per contract), never by plugin name. A
  stdio server is started from `mcp.json` with `${PLUGIN_DATA}` at
  `<workDir>/plugin-data/<name>` (created before the start), the SDK's minimal environment
  plus the server's own `env`, never the runtime's. A binding whose server the operator placed
  at a `url` is refused at boot until the kernel holds a host credential for it.
- **One connection per bound server, one `McpSource` (mode `plugin`).** Agents (the
  ToolRouter), the `/mcp/<wsId>` door and the app bridge reach the server through that
  source, named by the server's `mcp.json` key; the kernel's contract client
  (`BoundServer.call`) uses the same connection.
- **The host context is stamped in one place: the transport's `send`.** Every request to a
  bound server passes it, after every other `_meta` merge, and it overwrites
  `params._meta["ai.nimblebrain/context"]` (`contracts/host-context/CONTEXT.md`). Never set
  the context anywhere else, and never build a second transport to a bound server.
- **The principal comes from the call path, not from data.** `host` only inside
  `BoundServer.call`, whose scope lives in a module-private `AsyncLocalStorage` nothing
  exports; every other request presents `person`, with the workspace, signed-in identity and
  turn conversation from the request context. Do not export that scope or add a second way
  to present `host`.
- **Private tools are hidden by the source** (`hiddenTools`, from the binding's
  `privateTools`): left out of `tools/list` and so of every agent listing and the door, and
  refused by `execute` and `startToolAsTask`. That is tidiness; the server's `forbidden` is
  the boundary.
- **Lifecycle.** A server that does not start refuses the boot, naming the contract, plugin
  and server. One that exits is restarted on the next call that needs it (the kernel's own
  call, or an agent's through `McpSource` recovery); a call in flight when it exited is not
  retried. Shutdown settles queued writes, then stops it; a stopped server is never
  restarted.
