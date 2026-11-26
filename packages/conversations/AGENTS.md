# Conversations plugin

Scope: `packages/conversations/`. The built-in implementation of the conversations contract
(`contracts/conversations/CONTRACT.md`, `ai.nimblebrain.conversations` 1.0): an Agent Plugin
with one MCP server, on the local filesystem, and its screen. The runtime's default
configuration binds it (`src/config/plugins.ts`), so it is how every instance with chat stores
conversations. How to run it standalone is in `README.md`.

## Boundaries

- **Never import the kernel.** This package imports only `packages/server-sdk` and reads the
  contract document (`schemas/contracts/conversations/v1/contract.json`). The screen (`ui/`) is
  its own package and imports only its own files and its dependencies. Biome refuses any
  other import that leaves the package. A plugin depends on contracts; the kernel never imports
  a plugin, and a plugin never imports the kernel.
- **The contract document is the interface.** `tools/list` serves each tool's `$defs` schemas
  from the document unchanged, inputs are validated against them, and visibility comes from it.
  Changing a tool's shape is a contract change (`contracts/AGENTS.md`), never an edit here.
- **`plugin.json` and `mcp.json` follow Agent Plugins 1.0.0.** NimbleBrain's declaration is only
  `extensions["ai.nimblebrain"].implements`. Trust (`system`), presence and location are the
  operator's (`nimblebrain.json` `plugins`); nothing here sets them. `src/plugins` resolves this
  directory for `"source": "builtin"`.

## Calls

- **Every call's context is the host context** (`contracts/host-context/CONTEXT.md`), the
  object at `params._meta["ai.nimblebrain/context"]`, read by `packages/server-sdk`. Headers
  never carry it.
- **It is believed only from an authenticated host transport** (`src/main.ts`). stdio: by
  construction, the pipe the host started. HTTP: every request presents
  `Authorization: Bearer $NB_CONVERSATIONS_TOKEN`, the self-hosted host's credential the operator
  issues for this server, or is refused 401 before its body is read. The token is at least 32
  characters or the server refuses to start; it is `host` on every tool, so HTTP mode listens
  on `127.0.0.1` by default and warns on a non-loopback `--host`.
- **One server serves one deployment's host.** Hosting it behind a fleet edge, for several
  tenants, is not supported: it needs its own design (an edge-only credential, the edge
  stripping any client-sent identity headers, a network policy that admits only the edge), and
  one bearer token that is `host` for every tenant is not that design. A transport that verifies
  a dimension itself follows `contracts/host-context/CONTEXT.md` §4.
- **Every `tools/call` is decided in one order** (`src/server.ts`): unknown tool (`unknown_tool`), private tool by anyone but `host`
  (`forbidden`), arguments against the input schema (`invalid_input`), workspace and owner
  present (`scope_missing`), then the tool.
- **Errors are `{ code, error }`** from the contract's lists. A public error's text begins with
  its contract prefix. A public failure with no contract code is a JSON-RPC internal error.
- **An unexpected failure's detail goes only to stderr.** `internal_error` and the JSON-RPC
  internal error carry a fixed message; the detail (which can name a path) is logged, since
  no path crosses the contract (CONTRACT.md §8).
- **`active` and a trailing open run.** Whether a reply is generating is the host's to know. A
  call made inside a conversation (`conversationId` in its context) is made during that
  conversation's turn, so that conversation reads `active: true` and its trailing run
  `pending`; every other reads `false` and an unterminated trailing run reads `interrupted`.
  The host overlays every `list` row's `active` on the results it relays.

## Storage

- **Layout:** `<data>/workspaces/<workspaceId>/conversations/<ownerId>/<conversationId>.jsonl`,
  line 1 the header `create` wrote, every later line one event as `append_events` received it
  (`src/store.ts`). The runtime gives the plugin `<workDir>/plugin-data/conversations` as its
  data directory.
- **The path is the scope.** A call opens only its scope's owner partition of its scope's
  workspace. Scope ids must each be one path segment, or the call has no scope. A file whose
  header names another owner or id reads as absent.
- **The plugin never decides whether a workspace exists; the host does.** Every dimension of
  the host context is a fact the host verified, so a workspace it stamps exists: `create` makes
  `conversations/<ownerId>/` (and the workspace directory above it) on first use, and a
  workspace with no storage reads as one with no conversations.
- **`delete_workspace` purges.** It removes every owner's conversations and the workspace's
  `conversations/` directory, then the workspace directory if nothing else is in it (a data
  directory shared with other content keeps it). A `create` after a
  purge simply makes the storage again. That is correct: the host is the authority on which
  workspaces exist, and it keeps conversations out of a deleted workspace by never stamping
  one.
- **`seq` is position:** the place of an event among the lines after line 1 that are objects
  with a string `ts` and `type`. Lines are only appended, so a `seq` never changes and has no
  gaps. A torn line is no event; the next append starts on a new line.
- **A projection never makes a raw operation fail.** Event payloads are opaque, so every
  projection (`display.ts`, the scan's summary, search) reads each field as the shape it
  expects and skips anything else. An event the summary cannot fold still counts for `seq`;
  `events`, `append_events`, `delete` and `delete_workspace` never depend on a projection, and
  a public read leaves out what it could not project.
- **One process owns a data directory.** Writes to one conversation are serialized in-process;
  a batch is one append. Two processes writing one directory are not serialized, and a crash
  mid-append can leave the batch's complete lines written and a torn last line.
- **Lists read headers through a scan cache** (`src/scan.ts`) that resumes each file where the
  last read stopped, so a list during a long turn reads only what was appended.
- **Cursors are positions:** the last row's sort key and id, base64url. The next page is every
  row after that position in (sort key, id) order, so a conversation created between pages
  never shifts another.

## The screen

- `ui://conversations/browser` (`text/html;profile=mcp-app`) serves the built HTML at
  `--screen <file>`, by default `ui/dist/index.html` in this directory, and a placeholder page
  that says how to build it when that file is absent.
- **The screen's source is `ui/`**: its own Vite package (React, `@nimblebrain/synapse`,
  single-file build), installed, built and typechecked with the platform app UIs
  (`install:platform-apps`, `build:platform-apps`, `check:platform-apps` glob `packages/*/ui`)
  and built into the image beside them.
- **The server places its own screen.** Its handshake result (`initialize`, and
  `server/discover` on the 2026-07-28 revision) carries `_meta["ai.nimblebrain/host"]`
  (`HOST_META` in `src/server.ts`, `schemas/host/v1/host.schema.json`) with the sidebar
  placement. A host shows the screen from that metadata; nothing in the host names it.

## Tests

- `test/integration/conversations-plugin-conformance.test.ts` runs the contract's runner against
  `bin/nb-conversations --http` in full mode and public-only mode, with the host context in
  `_meta`, and checks the 401 and stdio. Full mode
  passes every case; public-only fails only `no private tool is listed`, which holds a host's
  agent-facing door, not an implementation.
- `test/integration/conversations-plugin-default.test.ts` boots a runtime with no `plugins`
  block, which binds this plugin: turns stored through it, the runner's public-only mode at the
  runtime's `/mcp/<wsId>` passing every case, the screen listed and served there and placed in
  the sidebar from the handshake, and `list` rows carrying the host's `active`.
- `test/unit/plugins/conversations-plugin-payloads.test.ts` appends schema-valid payloads no
  projection expects and checks every raw operation and public read still answers.
- `test/unit/plugins/builtin-conversations.test.ts` resolves this directory as a builtin system
  plugin and checks its contract binding.
- `test/helpers/conversation-store.ts` drives the kernel's contract store over this plugin's
  tool dispatch (`callTool`) in process, for tests that need the runtime's store without a
  server.
