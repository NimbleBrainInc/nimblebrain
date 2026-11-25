# Contracts

Each directory here is one language-neutral contract the kernel consumes (ADR-0076): its
`contract.json`, its normative `CONTRACT.md`, its closed `errors.json`, its JSON Schemas, and a
conformance runner that speaks only MCP.

- **A contract depends on nothing in `src/` at runtime.** The runner and anything an
  implementation loads read only the contract's own files. The one exception is build tooling:
  `scripts/emit-schemas.ts` reads TypeBox authoring sources, including one under `src/` where
  today's tools are a role (`src/platform/schemas/conversations.ts` is the conversations app
  role). Biome refuses a `src/` import from any other file here.
- **JSON is the published form; TypeBox is authoring source.** `schemas/**/*.json` is the
  contract and is committed. Its TypeBox source lives in `source/` (or, for a role that is
  today's tools, beside those tools). Never edit emitted JSON by hand.
- **A schema changes through `emit-schemas`.** Edit the TypeBox source, run
  `bun run emit:contracts`, commit the JSON. `bun run check:contracts` (in `verify:static`)
  runs each emitter with `--check` and fails on any missing, stale or leftover file.
- **Versioning is in each `CONTRACT.md`** (`major.minor`; same major compatible; a minor only
  adds; anything else is a new major at a new location). A change to an emitted schema is a
  contract change: decide which it is before landing it.
- **Transport is not contract.** How scope and credentials reach a server is documented as
  non-normative, and is a runner option, never a schema field.
