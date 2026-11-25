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
  It starts nothing and changes no routing yet.
