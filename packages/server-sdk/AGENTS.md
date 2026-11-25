# Server SDK (TypeScript)

Scope: `packages/server-sdk/`, `@nimblebrain/server-sdk`. The TypeScript counterpart of
`nimblebrain-server-sdk` (Python, `packages/server-sdk-py`): what a NimbleBrain plugin server
needs to serve a contract (ADR-0076), and nothing more. It is private until the kernel stamps
the host context on its calls.

It covers four things:

- **Reading the host context** (`readHostContext`, `callContext`): the object at
  `params._meta["ai.nimblebrain/context"]` (`contracts/host-context/CONTEXT.md`). The reader
  accepts exactly what `schemas/host-context/v1/host-context.schema.json` accepts and reads
  anything else as no context; its tests hold it to the schema with shared fixtures, so a
  reader in any language can be checked the same way.
- **Transport-verified dimensions**: `callContext(meta, { tenantId, workspaceId })` takes what
  the transport verified itself (an edge's `x-tenant-id`, `x-workspace-id`). A verified value
  wins; a context that contradicts it is `context_mismatch`, which the server answers before
  any tool runs. The tenant is returned for the server to wall by; it is never in the context.
- **Tool errors**: `toolError`, `ToolCallError`, the `{ code, error }` result every contract
  uses.
- **The principal rule and the contract document**: `refuseUnlessAllowed` refuses a private tool
  to anyone but `host`, before input and scope; `toolVisibility`, `toolsOf`, `contractSchema`
  and `publicErrorPrefix` read a contract's published `contract.json`.

Rules:

- **No dependencies, no I/O, no MCP library.** It takes plain values (a request's `_meta`, the
  dimensions a transport verified, a parsed contract document) and returns plain values, so a
  server on any MCP library uses it. Biome refuses an import from outside the package, from an
  MCP SDK, or from Ajv.
- **Reading is not trusting.** The SDK reads; the server decides whether its transport is the
  host's (stdio by construction, HTTP by the operator-issued credential) and reads `_meta` only
  then. Headers never carry the context; only dimensions a transport verified are passed in.
- **The contract document decides, never this package.** Never list a contract's tools,
  visibility or errors here.
- **A call that names no principal is not `host`.**
