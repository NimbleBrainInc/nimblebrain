# Plugin SDK

Scope: `packages/plugin-sdk/`. The small pieces every NimbleBrain plugin server needs to serve a
contract (ADR-0076), and nothing more.

- **It holds what each plugin would otherwise restate**: reading a call's authenticated context
  (`callContext`), the `{ code, error }` tool error (`toolError`, `ToolCallError`), and the
  principal rule for a contract's private tools (`refuseUnlessAllowed`).
- **No dependencies, no I/O, no MCP library.** It takes plain values (a request's `_meta`, a
  `Headers`, a parsed contract document) and returns plain values, so a plugin on any MCP
  library uses it. Biome refuses an import from outside the package, from an MCP SDK, or from
  Ajv.
- **The contract document decides, never this package.** Which tools are private, each tool's
  schemas and the public error prefixes come from the contract's published `contract.json`,
  which a plugin reads and passes in. Never list a contract's tools or visibility here.
- **Reading is not trusting.** `callContext` reads `params._meta["ai.nimblebrain/scope"]` first,
  then the `x-nb-*` headers when given. A server passes headers only for a request that
  presented the host's credential; over a pipe only the host holds (stdio), `_meta` is the
  host's word. The rule for each transport lives in the plugin that serves it.
- **The principal is checked before input and scope.** `refuseUnlessAllowed` runs first on every
  `tools/call`, so `forbidden` reveals nothing about the arguments or the scope. A call that
  names no principal is not `host`.
