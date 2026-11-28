# Server SDK (TypeScript)

Scope: `packages/server-sdk/`, `@nimblebrain/server-sdk`. The TypeScript counterpart of
`nimblebrain-server-sdk` (Python, `packages/server-sdk-py`): what a NimbleBrain plugin server
needs to serve a contract (ADR-0076), and nothing more. It is private until the kernel stamps
the host context on its calls.

It covers four things:

- **Reading the host context** (`readHostContext`): the object at
  `params._meta["ai.nimblebrain/context"]` (`contracts/host-context/CONTEXT.md`). The reader
  accepts exactly what `schemas/host-context/v1/host-context.schema.json` accepts and reads
  anything else as no context; its tests hold it to the schema with shared fixtures, so a
  reader in any language can be checked the same way.
- **Tool errors**: `toolError`, `ToolCallError`, the `{ code, error }` result every contract
  uses.
- **The principal rule and the contract document**: `refuseUnlessAllowed` refuses a private tool
  to anyone but `host`, before input and scope; `toolVisibility`, `toolsOf`, `contractSchema`
  and `publicErrorPrefix` read a contract's published `contract.json`. `contractSchema` returns
  a tool's schema with the shared `$defs` it refers to bundled beside it, so the schema a
  server lists compiles on its own.
- **Host metadata on the handshake** (`declareHostMeta`): carries a server's
  `_meta["ai.nimblebrain/host"]` block on its `initialize` and `server/discover` results. The
  MCP TypeScript SDK builds both in members it declares private, so the helper wraps them on
  the instance, reached structurally (no MCP import), and throws when they are gone;
  `test/unit/plugins/server-sdk-handshake.test.ts` guards an SDK upgrade that renames them.
  Every plugin server uses it rather than its own copy.
- **`grant` and `unattended` are read, never interpreted.** `readHostContext` exposes the run
  grant as the opaque string the host stamped (a server stores it and returns it verbatim) and
  `unattended` as a boolean; refusing a tool on an unattended call is the server's, from the
  contract document's marking.
- **`now` is read as the string the host stamped**, checked against the schema's pattern (RFC
  3339, UTC, `Z`). A server that decides on the call's instant parses it itself.

Rules:

- **No dependencies, no I/O, no MCP library.** It takes plain values (a request's `_meta`, a
  parsed contract document) and returns plain values, so a
  server on any MCP library uses it. Biome refuses an import from outside the package, from an
  MCP SDK, or from Ajv.
- **Reading is not trusting.** The SDK reads; the server decides whether its transport is the
  host's (stdio by construction, HTTP by the operator-issued credential) and reads `_meta` only
  then. Headers never carry the context. No server here has a transport that verifies a
  dimension itself; one that does applies `contracts/host-context/CONTEXT.md` §4.
- **The contract document decides, never this package.** Never list a contract's tools,
  visibility or errors here.
- **A call that names no principal is not `host`.**
