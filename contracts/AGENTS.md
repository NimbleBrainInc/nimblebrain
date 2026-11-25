# Contracts

Each directory here is the spec and tooling for one language-neutral contract the kernel
consumes (ADR-0076): its normative `CONTRACT.md`, the authoring sources of its document, the
script that emits the document, and a conformance runner that speaks only MCP. A contract
version is one JSON document, emitted to the published tree at
`schemas/contracts/<short-name>/v<major>/contract.json` (`schemas/AGENTS.md`).

- **A contract depends on nothing in `src/` at runtime.** The runner and anything an
  implementation loads read only the contract's published document. The one exception is
  build tooling: `scripts/emit-contract.ts` reads TypeBox authoring sources, including one
  under `src/` where today's tools are a contract's tools
  (`src/platform/schemas/conversations.ts` holds the conversations contract's public tools).
  Biome refuses a `src/` import from any other file here.
- **JSON is the published form; TypeBox is authoring source.** The document under `schemas/`
  is the contract and is committed. Its sources live in `source/`: a typed file for the
  identity, version, cardinality, tool visibility and errors, and TypeBox for the schemas (or,
  for tools that are today's tools, beside those tools). Never edit the emitted document by
  hand.
- **The document's `$id` is stated in `source/`, never derived from the contract id.** The id
  is the identity; the `$id` is where the document lives.
- **A tool's schemas are `$defs` entries** named `<tool>_input` and `<tool>_output`, each
  self-contained, and the tool points at them with `$ref`. Underscores keep each key a plain
  identifier, so codegen can name a type after it.
- **The contract changes through `emit-contract`.** Edit the source, run
  `bun run emit:contracts`, commit the document. `bun run check:contracts` (in
  `verify:static`) runs each emitter with `--check` and fails on a missing or stale document.
- **Versioning is in each `CONTRACT.md`** (`major.minor`; same major compatible; a minor only
  adds and is served in place; anything else is a new major directory). A change to the
  emitted document is a contract change: decide which it is before landing it.
- **Transport is not contract.** How scope, principal and credentials reach a server is
  documented as non-normative, and is a runner option, never a schema field.
