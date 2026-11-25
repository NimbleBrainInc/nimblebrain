# Conversations plugin

Scope: `packages/conversations/`. The built-in implementation of the conversations contract
(`contracts/conversations/CONTRACT.md`, `ai.nimblebrain.conversations` 1.0): an Agent Plugin
with one MCP server, on the local filesystem. How to run it standalone is in `README.md`.

## Boundaries

- **Never import the kernel.** This package imports only `packages/server-sdk` and reads the
  contract document (`schemas/contracts/conversations/v1/contract.json`). Biome refuses any
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
  issues for this server, or is refused 401 before its body is read.
- **Fleet mode (`--http --edge`)**: an edge verifies the host and sets `x-tenant-id` and
  `x-workspace-id`. The tenant walls every call (its data under `<data>/tenants/<tenantId>/`, the
  layout below inside it); a request with no verified tenant is refused 400. A context whose
  `workspaceId` differs from the verified one is `context_mismatch`, a JSON-RPC error before any
  tool runs; an absent one takes the verified value.
- **Every `tools/call` is decided in one order** (`src/server.ts`): the context
  (`context_mismatch`), unknown tool (`unknown_tool`), private tool by anyone but `host`
  (`forbidden`), arguments against the input schema (`invalid_input`), workspace and owner
  present (`scope_missing`), then the tool.
- **Errors are `{ code, error }`** from the contract's lists. A public error's text begins with
  its contract prefix. A public failure with no contract code is a JSON-RPC error.
- **`active` and a trailing open run.** Whether a reply is generating is the host's to know. A
  call made inside a conversation (`conversationId` in its context) is made during that
  conversation's turn, so that conversation reads `active: true` and its trailing run
  `pending`; every other reads `false` and an unterminated trailing run reads `interrupted`.
  The host overlays the rest.

## Storage

- **Layout:** `<data>/workspaces/<workspaceId>/conversations/<ownerId>/<conversationId>.jsonl`,
  line 1 the header `create` wrote, every later line one event as `append_events` received it.
  It is the runtime's own conversation layout under its work directory, so the plugin given a
  runtime's work directory reads and writes the same files (`src/store.ts`).
- **The path is the scope.** A call opens only its scope's owner partition of its scope's
  workspace. Scope ids must each be one path segment, or the call has no scope. A file whose
  header names another owner or id reads as absent.
- **A workspace exists when its directory does, and the plugin never creates one.** `create`
  makes `conversations/<ownerId>/` one level at a time inside an existing workspace directory,
  so a write after the workspace is removed fails `workspace_not_found` instead of bringing it
  back. `delete_workspace` removes the conversation files and leaves the workspace directory.
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
  `--screen <file>`, by default `ui/index.html` in this directory, and a placeholder page when
  that file is absent. The screen's source is not in this package.

## Tests

- `test/integration/conversations-plugin-conformance.test.ts` runs the contract's runner against
  `bin/nb-conversations --http` in full mode and public-only mode, with the host context in
  `_meta`, and checks the 401, stdio, and fleet mode (tenant walls, `context_mismatch`). Full mode passes every case; public-only fails only
  `no private tool is listed`, which holds a host's agent-facing door, not an implementation.
- `test/unit/plugins/conversations-plugin-parity.test.ts` compares every public read with the
  built-in app's for the same files and for the same events.
- `test/unit/plugins/conversations-plugin-payloads.test.ts` appends schema-valid payloads no
  projection expects and checks every raw operation and public read still answers.
- `test/unit/plugins/builtin-conversations.test.ts` resolves this directory as a builtin system
  plugin and checks its contract binding.
