# Contracts

Each directory here is the spec and tooling for one language-neutral contract the kernel
consumes (ADR-0076): its normative `CONTRACT.md`, the authoring sources of its document, and a
conformance runner that speaks only MCP. `scripts/` holds the one emitter that writes every
contract's document, and `host-context/` the call context they share. A contract
version is one JSON document, emitted to the published tree at
`schemas/contracts/<short-name>/v<major>/contract.json` (`schemas/AGENTS.md`).

- **A contract depends on nothing in `src/`.** Its sources and its runner live in its own
  directory, and the runner and anything an implementation loads read only the published
  document. Biome refuses a `src/` import from any file here.
- **JSON is the published form; TypeBox is authoring source.** The document under `schemas/`
  is the contract and is committed. Its sources live in `source/`: `contract.ts` for the
  identity, version, cardinality, `grants`, each tool's visibility and unattended marking, and
  the errors; `public.ts` and `private.ts` for the schemas; `index.ts` joining them as one
  `ContractSource` (`scripts/contract-source.ts`). Never edit the emitted document by hand.
- **Every tool states `visibility` and `unattended`.** `unattended` (`allowed` or `refused`)
  says whether a call made inside an unattended run may reach it; the host reads it from the
  document, never from a list of its own. A private tool is always `refused`; the emitter
  refuses anything else.
- **The document's `$id` is stated in `source/`, never derived from its `contract` field.**
  `contract` is the identity (the name `implements[].contract` uses); the `$id` is where the
  document lives. The document is a valid JSON Schema 2020-12 document and compiles whole.
- **A tool's schemas are `$defs` entries** named `<tool>_input` and `<tool>_output`, each
  self-contained, and the tool points at them with `$ref`. Underscores keep each key a plain
  identifier, so codegen can name a type after it.
- **One emitter writes every contract.** `scripts/emit-contracts.ts` lists each contract's
  `source/index.ts`; a new contract adds its line there. Edit a source, run
  `bun run emit:contracts`, commit the document. `bun run check:contracts` (in
  `verify:static`) runs the emitter with `--check` and fails on a missing or stale document.
- **Versioning is in each `CONTRACT.md`** (`major.minor`; same major compatible; a minor only
  adds and is served in place; anything else is a new major directory). A change to the
  emitted document is a contract change: decide which it is before landing it.
- **The call context is one shared spec, not each contract's.** `host-context/CONTEXT.md` is
  the normative rule for how a host stamps scope and principal on every request
  (`params._meta["ai.nimblebrain/context"]`) and when a server believes it; its schema is
  authored at `schemas/host-context/v1/host-context.schema.json`. A contract points at it and
  says only which dimensions its tools read and what each answers when one is missing.
- **Transport is not contract.** Credentials and how a runner reaches a server are runner
  options, never schema fields; scope and principal reach every server as the host context.

| Contract | Spec | Document | Runner |
|---|---|---|---|
| `ai.nimblebrain.conversations` | `conversations/CONTRACT.md` | `schemas/contracts/conversations/v1/contract.json` | `conversations/runner/conformance.ts` |
| `ai.nimblebrain.tasks` | `tasks/CONTRACT.md` | `schemas/contracts/tasks/v1/contract.json` | none yet (CONTRACT.md §15) |
