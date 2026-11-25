# Plugins

Scope: `src/plugins/`. Reading Agent Plugins, the `ai.nimblebrain` extension, the contract
registry, and resolving the plugins an operator configures (ADR-0068, ADR-0076).

## One manifest format

- **A catalog plugin and a system plugin are the same format.** An Agent Plugins 1.0.0
  directory: root `plugin.json`, servers in `mcp.json`, skills in `skills/<name>/SKILL.md`.
  NimbleBrain's fields live only under `extensions["ai.nimblebrain"]`, so the directory
  installs unchanged on other hosts.
- **`manifest.ts` is the one reader of `plugin.json` and the extension.** Code that needs a
  manifest field calls it; never parse `extensions["ai.nimblebrain"]` anywhere else
  (`src/skills/connector-skill-resolver.ts` reads its catalog plugins through it).
  - `parsePluginManifest` is strict, for a plugin the operator configured: the format's
    schemas (vendored in `schemas/`, never fetched), the format's prose rules (one-token
    `command`, `cwd` inside its root, HTTPS off loopback, `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`
    expanded only in `args`, `env` and `cwd`), and the extension's schema. Every problem
    names the plugin, the file and the field. An unknown top-level manifest field is a
    warning, because the format says report and ignore.
  - `nimblebrainExtension` is lenient, for a manifest a pinned catalog vouches for: it
    drops a malformed field instead of failing the read.
- **The vendored `schemas/agent-plugins-1.0.0-*.json` are the format's, byte for byte.**
  Replace them only with the published versions; never edit them.

## The extension is additive and published

- **`extension.ts` (TypeBox) is the source; `schemas/plugin-extension.schema.json` is the
  published form** (`$id` `https://schemas.nimblebrain.ai/v1/plugin-extension.schema.json`)
  and what the loader validates. Edit the TypeBox, run `bun run emit:plugin-extension` then
  `bun run format`; `bun run check:plugin-extension` (in `verify:static`) fails on drift.
- **v1 only adds.** Every field is optional and objects are open, so what the catalog emits
  today (`servers`, `conversationStarters`, and `nimblebrainOnly` in its AI Catalog) stays
  valid. A rename or removal is a new path (`/v2/`), never an edit.
- **Each fact has one home.** How a server starts or is reached: `mcp.json`. Its registry
  name: the extension's `servers` (key to name). Its auth and placements: that registry
  entry's `_meta` (`ai.nimblebrain/host`), never the extension. Which server fills a
  contract role: `implements[].servers`, role to server key, a key of `mcp.json` or of the
  extension's `servers`. Never declare a server inside the extension: the format forbids
  MCP configuration in `plugin.json`, and a second home drifts.
- **The extension declares capabilities, never trust.** Nothing in it makes a plugin a
  system plugin, sets where a server runs, or switches a kernel feature.

## System is an operator decision

- **Only `nimblebrain.json` `plugins.<name>.system` makes a system plugin**
  (`src/config/plugins.ts`). A manifest field that tried would be ignored, so none exists.
- **Only a system plugin's `stdio` servers are started**; any other plugin's servers are
  reached by URL (ADR-0076, the one exception to ADR-0068's remote-only rule). An operator's
  `servers.<role or key>.url` reaches a server where it already runs instead.
- **A private role is the contract's decision.** The host never exposes a private role's
  server to agents or apps; that is enforced where servers are registered, not by hiding
  the server's declaration.

## Contracts and the kernel

- **`contracts.ts` reads `contracts/*/contract.json` and names no contract in code.**
  Version: same major, minor at least the one needed. Roles: every role mapped, none
  extra. Cardinality: a `singleton` has at most one enabled implementation.
- **The kernel never names a plugin.** A kernel feature that needs a capability names the
  contract and asks for its binding; nothing here branches on a plugin's name.
- **`checkConfiguredPlugins` is the boot hook.** With no plugin enabled it reads nothing
  (not even `contracts/`), so an instance without a `plugins` block boots as before. With
  plugins it validates, logs the resolved set, and throws naming every error. It starts
  nothing and changes no routing yet.
