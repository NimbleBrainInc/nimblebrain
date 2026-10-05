# Platform Apps — Authoring Rules

**Scope.** When you add or modify a tool under `src/platform/`, follow the
directives below. Higher-level conventions live in the repo-root `AGENTS.md`
/ `CLAUDE.md`; architecture lives in the root `README.md`.

This file is normative. Each rule has a reason; the reasons are short. Do
not negotiate around them.

---

## 0. One app, one directory

A platform app is an in-process MCP server the kernel hosts: its tools, the
code behind them, and its UI. All of that lives under `src/platform/<app>/`.
An app is not a connector — the runtime does not fetch or execute it, it
*is* the runtime — so nothing about it belongs under `src/connectors/`, which
holds connector code only.

```
src/platform/
  index.ts              createPlatformSources — every app, started and ready
  types.ts              PlatformToolContext
  schemas/              TypeBox tool contracts, one module per app (§2)
  <app>/
    source.ts           defineInProcessApp — the app's MCP server
    ui-resource.ts      reads ui/dist/index.html for the `ui://` resource
    ui/                 its own Vite package (package.json, bun.lock, dist)
    *.ts                whatever the tools are implemented on
```

`schemas/` stays one tree rather than one file per app directory: it is the
root the web `.d.ts` codegen compiles (`scripts/tsconfig.codegen-web.json`),
and the generated tree under `web/src/_generated/platform-schemas/` mirrors
its shape.

Register a new app in `index.ts`. Its UI, if it has one, is picked up by
`build:platform-apps`, `check:platform-apps`, and the image build from the
`src/platform/*/ui` glob — there is no list to add it to. The typecheck needs
two configs in the UI package: `tsconfig.json` for the shipped source (browser
libs, no Bun types, tests excluded) and `tsconfig.test.json` extending it with
`types: ["vite/client", "bun"]` so `bun:test` resolves. Copy both from an
existing app; `scripts/check-platform-apps.ts` says why each exists.

An app's placements are the `placements:` array passed to `defineInProcessApp`,
and that is the only copy the runtime reads. Two apps also carry a
`manifest.json` restating them in `ai.nimblebrain/host` form; nothing loads it.
Do not add one to a new app, and do not treat the pair as a contract.

**A built-in app serves its `ui://` resource as `text/html;profile=mcp-app`**, the MCP Apps MIME type. Use `MCP_APP_MIME_TYPE` (`src/tools/in-process-app.ts`), never a literal or plain `text/html`.

---

## 1. Four contract invariants

Every platform tool MUST satisfy these four. The schema-shape lint
(`test/unit/platform/schema-shape.test.ts`) enforces parts of (1) and
(2) automatically; the rest is discipline plus PR review.

### 1.1 MCP-native

Every source is built with `defineInProcessApp` from
`src/tools/in-process-app.ts`. The factory returns an `McpSource` backed by
a real MCP `Server` over `InMemoryTransport`. Tools surface via standard
`tools/list` / `tools/call` — byte-identical to a subprocess MCP server.

- DO build sources via `defineInProcessApp({ name, version, tools, ... })`.
- DO NOT create platform-only registries, custom dispatch paths, or fields
  that exist only on the internal API surface and not on `/mcp`.
- DO NOT bypass the registry to expose tools "just to the web shell."

If the model can't reach it through `/mcp`, neither can Claude Code,
Cursor, or any other MCP client. That's a regression.

### 1.2 Strict input schemas

Every tool's `inputSchema` is a fully typed JSON Schema. The lint enforces:

- Top-level `inputSchema.type === "object"` with `properties` declared.
- Every nested property of type `"object"` declares `properties`.
- Every property of type `"array"` declares `items`.

Beyond what the lint catches, you SHOULD also:

- Use `enum` for any constrained string (scope, type, status).
- Use `pattern` for identifiers (`^[a-zA-Z0-9_-]+$` for kebab/snake names).
- Use `minimum` / `maximum` for bounded numbers.
- Mark `required` fields explicitly.

Bare `{ type: "object" }` invites the model to invent structure under-spec
— it will serialize a nested object as a JSON-string, then your validator
rejects it, then the user sees "Couldn't create" with no signal what went
wrong. This actually happened in `conv_30076c3681ad4c91`.

### 1.3 Storage-symmetric shape

Tools that author a persistent thing use:

```
{ scope?: <enum>, manifest: { ...typed fields }, body: <string> }
```

- `manifest` mirrors the on-disk metadata field-for-field. For skills,
  it's the YAML frontmatter; for tasks, the stored Task
  config; for files, the FileEntry metadata.
- `body` is the content payload — markdown for skills, prompt for
  tasks, base64 for files.
- `scope` (when present) selects where to write — typically
  `"org" | "workspace" | "user"`. Omit when there's only one valid scope.

DO NOT put the name at the root. `name` lives inside `manifest` because
it's part of the on-disk identity. The agent's mental map of your input
should match the file it's about to write.

For update-style tools, the shape is:

```
{ id: <string>, manifest?: <Partial of create-shape>, body?: <string> }
```

- `id` (or `name` for name-keyed stores) at the root identifies the
  target.
- `manifest` is a partial patch — every field optional.
- `body` is optional; omitting means "keep current".

**Every update tool is a patch, and `null` clears.** Write a new update
tool this way, and move an existing one onto it when you change its fields,
under `src/platform/` or `src/tools/` (`set_model_config` is the reference).
Not every tool follows it yet: `set_preferences` has no clear for its
scalar fields, and its `model` field also takes `""`, because `get_config`
reports an unset preference as `""` and a client writes back what it read.

| Caller sends | Meaning |
|---|---|
| field omitted | leave it unchanged |
| a value | set it |
| `null` | clear it: remove the stored value so the default applies again |

- Declare a clearable field as `anyOf: [<typed schema>, { type: "null" }]`,
  with constraints such as `enum` or `minimum` on the typed branch. Never
  `type: [T, "null"]` with `null` in an `enum`: Gemini rejects it, and that
  fails every tool call for the tenant. The schema-shape lint refuses it.
- No `clear<Field>: true` flags and no `""` as a clear. Each is a second
  spelling of `null` that callers must learn per tool. Refuse a stray one
  with an error that says to pass `null`.
- A clear deletes the stored key, on disk and in the live process alike. A
  stored `null` reads back as a choice the operator never made.
- Every settable field needs its clear, or "unset" is a state an operator can
  leave but never return to.
- Each field validates and applies on its own, so a caller (a settings form
  saving one field at a time) can send any single field. If two fields must
  change together, name the pair in the tool description and validate it.

### 1.4 Minimum sufficient surface

The schema enumerates only what a typical caller needs for a successful
call. Operator/runtime-set fields belong on the type and the on-disk file,
not in the LLM-facing schema.

EXCLUDE from the LLM-facing schema:

- Source-of-truth fields the runtime sets (`source`, `ownerId`,
  `workspaceId`, `createdAt`).
- Literal-tool-name affinity strings (e.g. `tool-affinity` globs). Usually
  leaky — they couple a tool's input to connector identities that change.
  (The skills tool is the deliberate exception: a skill author genuinely
  chooses *when* a skill loads, so `tool-affinity` is authorable there.)
- "Designed-but-not-enforced" placeholder fields. If a feature isn't
  shipping, the schema doesn't list it. (The skill cutover removed
  `overrides` / `derived-from` for exactly this reason.)
- Versioning metadata the writer fills in (`version` defaulting to
  `1.0.0`) — make it optional.

Test: if a field is set by the runtime in 100% of cases, it does not
belong in the LLM-facing schema. Set it in the handler.

**Internal callers use the domain API, not the tool handler.** When a
domain has both LLM-facing and operator-facing callers (CLI, connector
lifecycle, settings UI), factor a `domain.ts` module that accepts the
full shape including operator fields. The tool handler becomes a thin
wrapper that narrows the input and stamps `source: "agent"`. Internal
callers (CLI, lifecycle.ts) call the domain directly via a runtime-
exposed getter. **The CLI does not call the LLM-facing tool — that path
silently no-ops or strips operator fields.** See
`src/platform/tasks/domain.ts` for the reference implementation
and `src/runtime/runtime.ts::registerTasksContext` for the wiring.

The cost of doing this once per domain: one extra file. The cost of not
doing it: connector install loses connector-contributed schedules, CLI pause/
resume silently no-ops, and the tool surface accumulates operator fields
to "make it work" — exactly what (1.4) forbids.

---

## 2. Handler contract

Handlers receive `Record<string, unknown>` from the MCP framework but read
typed fields immediately. The validator (`validateToolInput`) has already
enforced the schema before dispatch.

```ts
interface CreateInput {
  scope: WritableScope;
  manifest: { name: string; description: string; loadingStrategy: SkillLoadingStrategy; ... };
  body: string;
}

async function createSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const { scope, manifest, body } = args as unknown as CreateInput;
  // ... handler logic, no defensive re-validation
}
```

- DO declare a typed `interface XxxInput` matching the schema 1:1.
- DO cast once at the top via `args as unknown as XxxInput`.
- DO NOT accept multiple input shapes "for compat" — the LLM sees one
  schema; honor exactly that.
- DO NOT plick fields off `args` with manual `if (typeof args.foo === "string")`
  guards. The validator already did this work.
- DO NOT coerce kebab-case / snake_case / camelCase variants. The schema
  declares one casing; reject the rest.

If you need to migrate persisted data with a different shape (legacy
on-disk formats, etc.), do that in the storage layer (`writer.ts`,
`loader.ts`), not in the tool handler.

---

## 2.1. Handler output types are shared, named, and the handler's return type

Inputs have a strong shared-type story: TypeBox schemas in
`src/platform/schemas/`, derived static types via `Static<typeof X>`,
codegen to web. Outputs need the same shape. **The handler's TypeScript
return type IS the contract; the schemas file is where it's declared so
every consumer (CLI, integration tests, web client, future apps) imports
the same name.**

Why this matters: until this rule was enforced, every consumer redeclared
response shapes inline with `as { … }`. The `tasks__run` handler
gained a `{ status: "dispatched" }` branch; the CLI was casting blindly to
`{ run }` and crashed on every run that outlasted the 30 s sync-wait. Five
review rounds on the same PR each surfaced one more drifted surface
(regex, schema description, CLI cast, integration test, PR body). The fix
is structural, not procedural: the type system enforces the contract.

DO:

```ts
// src/platform/schemas/tasks.ts — named, exported, type-only OK
export type TasksRunOutput =
  | { run: TaskRunRecord; enabled: boolean; message?: string }
  | { status: "dispatched"; taskId: string; startedAt: string; enabled: boolean; message: string };

// src/platform/tasks/server.ts — handler return type is the contract
export async function handleRun(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<TasksRunOutput> { ... }

// a consumer module imports the same contract type
import type { TasksRunOutput } from "../../platform/schemas/tasks.ts";
const data = (await callTool(runtime, "tasks__run", { taskId })) as TasksRunOutput;
if ("status" in data && data.status === "dispatched") { ... } else if ("run" in data) { ... }
```

DO NOT:

```ts
// Inline cast — re-declares the shape, drifts the first time the handler changes.
const data = (await callTool(runtime, "tasks__run", { taskId })) as {
  run: { id: string; status: string; /* ... */ };
};
const r = data.run;  // crashes on dispatched envelope
```

DO NOT use `as { run }` against a typed-discriminated handler. That narrows
the union without runtime evidence and bypasses the only check that would
catch a future shape change. Narrow via `"run" in data` (or `data.status ===
"dispatched"`) — the type system then forces every consumer to handle every
branch.

### In-process platform-tool variant

`src/platform/tasks/server.ts`-style handlers return their
domain object directly (`Promise<TasksRunOutput>`) and the
framework wraps them as MCP `ToolResult` at registration time. That's
the simplest §2.1 shape — the handler's return type IS the contract.

In-process platform tools registered via `defineInProcessApp` return
`Promise<ToolResult>` directly because they build the MCP-boundary
shape themselves (`content` for the human summary, `structuredContent`
for the typed payload, `isError` for the error flag). To still get
compile-time drift coverage:

```ts
handler: async (input): Promise<ToolResult> => {
  const list = await listSkills(...);
  const out: SkillsListOutput = { skills: list };  // ← shape pinned here
  return {
    content: textContent(summarizeList(list)),
    // Wire-format cast: `structuredContent` is `Record<string, unknown>`
    // and TS doesn't structurally widen interfaces into it. The named
    // `out` declaration above is the load-bearing assertion.
    structuredContent: out as unknown as Record<string, unknown>,
    isError: false,
  };
},
```

The discipline is the same — a named `XxxOutput` from `schemas/` —
just expressed at the construction site rather than the handler
signature. Either form satisfies §2.1; pick by which layer authored
the handler. See `src/platform/skills/source.ts` for the
handler-signature form; `src/platform/tasks/server.ts` for the
construction-site form.

### Output schemas vs input schemas

Output types are typically **type-only** exports — no TypeBox runtime
schema. We don't validate outputs at the MCP boundary; the handler's
TypeScript return type already constrains it. If you ever need wire
validation on a specific output (e.g. a particularly user-visible API),
add the TypeBox version then — but the type-only export is the floor.

When you change a handler's return shape, update the matching output type
in `schemas/` **in the same commit**. Treat it like a database migration:
shape moves and consumers move together, not separately.

### Tests must use the shared types too

Integration tests and consumer-pattern unit tests import the same
`TasksXxxOutput` names. Inline `as { … }` in tests has the same
drift problem as in production code — and is harder to find because tests
that pass are easy to assume correct.

For discriminated unions, tests MUST narrow before dereferencing:

```ts
// Good — narrowing makes the dispatched branch a compile error if you
// forget to handle it.
const result = await handleRun({ taskId: "foo" }, ctx);
if (!("run" in result)) throw new Error(`expected sync shape, got ${JSON.stringify(result)}`);
expect(result.run.toolCalls).toBe(3);

// Bad — `as { run }` narrows without runtime evidence; future regressions
// (handler returns dispatched envelope under load) pass with undefined
// dereferences.
const result = (await handleRun({ taskId: "foo" }, ctx)) as { run: TaskRun };
expect(result.run.toolCalls).toBe(3);
```

### Tests are typechecked

`check:test-signatures` (in `verify:static`) typechecks `test/` under
`tsconfig.test.json`, so a test typed with the named output type fails the
build when the handler's shape moves. An inline `as { … }` escapes that check;
that is why tests import the same names.

For SDK boundary tests in particular (anything that mocks an `McpError`,
`Task`, `CallToolResult`, etc.), construct **real instances of the
production types**. Plain `{ message: "..." }` mocks of an `McpError`
masked a no-op recovery regex through one full review cycle — the test
passed, production stayed broken. Match the production type strictly.

---

## 3. Anti-patterns

| Anti-pattern | Why it's wrong |
|---|---|
| Bare `{ type: "object" }` | Model invents structure; serializes nested objects as JSON strings |
| `name` at root, `description` in manifest | Splits identity; model packs everything into one place and gets it wrong |
| `allowedTools: string[]` as anything but a run's enforced allowlist | Leaky abstraction — couples identity to connector names that change. A task takes one because narrowing its runs' tools is the point and the run's tool router enforces it; describe it with `<connector>__*` globs |
| `source`, `ownerId` in input schema | Runtime fields the LLM has no business setting |
| Designed-but-not-enforced placeholder fields | Confuses callers; schema lies about what's load-bearing |
| Multiple casings accepted in handler | Hides the contract; one casing won, document it |
| `clearX: true` flag, or `""`, to unset a field | A second spelling of `null`; the clear is `null` (§1.3) |
| Update tool that replaces the whole record | A caller that changes one field must resend every other one, and an omitted field is lost; take a patch (§1.3) |
| Defensive `validateTaskFields(args)` after schema validation | Validator already ran; redundant code that drifts from the schema |
| Storing config in `manifest` AND a flat field at root | Two sources of truth; one will get out of sync |
| Inline `as { … }` on a `callTool(...)` / `handleX(...)` return | Re-declares the contract; drifts the first time the handler changes. Import the named output type from `schemas/` (§2.1). |
| Handler typed as `Promise<object>` / `: object` | The return type IS the contract — give it a name. `: TasksRunOutput` catches drift at compile time across every consumer. |
| `as { run }` on a discriminated-union return | Narrows without runtime evidence; bypasses the only check that would catch a new branch. Narrow via `"run" in data` / `data.status === "..."` instead. |
| Test mocks plain `{ message: "..." }` for an `McpError` | SDK constructs real `McpError` instances; plain objects don't match the production wire shape and mask bugs. Use `new McpError(code, message)`. |

---

## 4. Adding a new tool — checklist

1. **Define `inputSchema`.** Follow the storage-symmetric shape (1.3).
   Strong types throughout (1.2). For shared fields (skills' manifest,
   tasks' schedule), pull into a top-of-file const so create + update
   reference the same definition.
2. **Define `interface XxxInput`.** Match the schema 1:1.
3. **Define output types.** Named `XxxOutput` exports in the same
   `schemas/<source>.ts` file (§2.1). Discriminated unions for handlers
   that return multiple shapes. Type-only is the floor; add TypeBox only
   if you need wire validation.
4. **Write the handler.** Cast input via `as unknown as XxxInput` at the
   top. **Annotate the return type** with the named `XxxOutput` — that's
   what makes consumer drift a compile error. No `: object`.
5. **Add a unit test.** One happy path. One validator rejection (schema
   should reject malformed input before the handler runs). Test direct
   handler calls — not the full MCP roundtrip — for speed. For
   discriminated-union outputs, narrow via `"key" in result` rather than
   `as { … }`.
6. **Run the lint.** `bun test --no-env-file test/unit/platform/schema-shape.test.ts`
   should still pass. New sources need to be registered in the lint's
   `SOURCES` array; new tools on existing sources are auto-detected via
   `tools/list`.
7. **Run `bun run verify`.** Mirrors CI.

When changing an existing handler's return shape, treat it like a database
migration: update the `XxxOutput` type in `schemas/` and every consumer
(CLI, tests, web client, tool description) in the same commit. The TypeBox
catalog covers inputs; §2.1 output types cover the other half. Search-and-
update by grep is the discipline; the type system is the safety net.

---

## 5. Where the convention is enforced

- **Lint**: `test/unit/platform/schema-shape.test.ts` walks every
  source's `tools/list`, the core `nb` tools included, and rejects bare
  object/array shapes, `clear<Field>` flags, and a `null` inside an `enum`.
- **Type system**: typed `interface XxxInput` per handler — drift between
  the schema and the type surfaces at compile.
- **Type system, output side (§2.1)**: handler return types are the named
  `XxxOutput` exports from `schemas/`; consumers import and narrow, and
  consumer drift, tests included, surfaces at compile.
- **Check, output side (§2.1)**: `bun run check:platform-output-types`
  (in `verify:static`) fails on any function under `src/platform/` declared
  to return `object` or `Promise<object>`. Rule doc: `CODE_STYLE.md`,
  "Platform tool handlers return a named output type".
- **Code review**: section 3 (anti-patterns) — flag in PRs explicitly.

If you're tempted to violate any of section 1, ask whether the underlying
need is actually load-bearing for the LLM or operator-only. If
operator-only, route it through a non-LLM path (direct file edit,
runtime-applied default, settings UI) and keep the tool surface clean.

---

## 6. After editing `schemas/`

Run `bun run codegen` after touching any file in
`src/platform/schemas/`. Regenerates the `.d.ts` tree at
`web/src/_generated/platform-schemas/` (web is a separate package and
can't import schemas directly). CI gates on `check:codegen` in
`verify:static`; `bun run verify` runs it implicitly. Server-side
imports of `schemas/` are intra-package — no codegen needed.
