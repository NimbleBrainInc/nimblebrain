# Platform Tools — Authoring Rules

**Scope.** When you add or modify a tool under `src/tools/platform/` (or
`src/bundles/<name>/` if that bundle hasn't overridden these rules), follow
the directives below. Higher-level conventions live in the repo-root
`AGENTS.md` / `CLAUDE.md`; architecture lives in the root `README.md`.

This file is normative. Each rule has a reason; the reasons are short. Do
not negotiate around them.

---

## 1. Four contract invariants

Every platform tool MUST satisfy these four. The schema-shape lint
(`test/unit/tools/platform/schema-shape.test.ts`) enforces parts of (1) and
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
  it's the YAML frontmatter; for automations, the stored Automation
  config; for files, the FileEntry metadata.
- `body` is the content payload — markdown for skills, prompt for
  automations, base64 for files.
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

### 1.4 Minimum sufficient surface

The schema enumerates only what a typical caller needs for a successful
call. Operator/runtime-set fields belong on the type and the on-disk file,
not in the LLM-facing schema.

EXCLUDE from the LLM-facing schema:

- Source-of-truth fields the runtime sets (`source`, `bundleName`,
  `ownerId`, `workspaceId`, `createdAt`).
- Literal-tool-name affinity strings (`allowedTools`, `appliesToTools`).
  These are leaky abstractions — they couple your tool to bundle
  identities that change. If affinity matters, use a semantic-match
  strategy (description embeddings, keyword triggers in metadata).
- "Designed-but-not-enforced" placeholders (`overrides`, `derivedFrom`).
  If a feature isn't shipping, the schema doesn't list it.
- Versioning metadata the writer fills in (`version` defaulting to
  `1.0.0`) — make it optional.

Test: if a field is set by the runtime in 100% of cases, it does not
belong in the LLM-facing schema. Set it in the handler.

---

## 2. Handler contract

Handlers receive `Record<string, unknown>` from the MCP framework but read
typed fields immediately. The validator (`validateToolInput`) has already
enforced the schema before dispatch.

```ts
interface CreateInput {
  scope: WritableScope;
  manifest: { name: string; description: string; type: SkillType; ... };
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

## 3. Anti-patterns

| Anti-pattern | Why it's wrong |
|---|---|
| Bare `{ type: "object" }` | Model invents structure; serializes nested objects as JSON strings |
| `name` at root, `description` in manifest | Splits identity; model packs everything into one place and gets it wrong |
| `allowedTools: string[]` | Leaky abstraction — couples skill/automation identity to bundle names that change |
| `source`, `bundleName`, `ownerId` in input schema | Runtime fields the LLM has no business setting |
| `overrides`, `derivedFrom` (designed-but-not-enforced) | Confuses callers; schema lies about what's load-bearing |
| Multiple casings accepted in handler | Hides the contract; one casing won, document it |
| Defensive `validateAutomationFields(args)` after schema validation | Validator already ran; redundant code that drifts from the schema |
| Storing config in `manifest` AND a flat field at root | Two sources of truth; one will get out of sync |

---

## 4. Adding a new tool — checklist

1. **Define `inputSchema`.** Follow the storage-symmetric shape (1.3).
   Strong types throughout (1.2). For shared fields (skills' manifest,
   automations' schedule), pull into a top-of-file const so create + update
   reference the same definition.
2. **Define `interface XxxInput`.** Match the schema 1:1.
3. **Write the handler.** Cast input via `as unknown as XxxInput` at the
   top. No defensive validation, no coercion, no flat-field plucking.
4. **Add a unit test.** One happy path. One validator rejection (schema
   should reject malformed input before the handler runs). Test direct
   handler calls — not the full MCP roundtrip — for speed.
5. **Run the lint.** `bun test test/unit/tools/platform/schema-shape.test.ts`
   should still pass. New sources need to be registered in the lint's
   `SOURCES` array; new tools on existing sources are auto-detected via
   `tools/list`.
6. **Run `bun run verify`.** Mirrors CI.

---

## 5. Where the convention is enforced

- **Lint**: `test/unit/tools/platform/schema-shape.test.ts` walks every
  source's `tools/list` and rejects bare object/array shapes.
- **Type system**: typed `interface XxxInput` per handler — drift between
  the schema and the type surfaces at compile.
- **Code review**: section 3 (anti-patterns) — flag in PRs explicitly.

If you're tempted to violate any of section 1, ask whether the underlying
need is actually load-bearing for the LLM or operator-only. If
operator-only, route it through a non-LLM path (direct file edit,
runtime-applied default, settings UI) and keep the tool surface clean.
