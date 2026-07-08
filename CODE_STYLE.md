# Code Style

Project-specific code-style and quality-control rules that go beyond what
Biome and `tsc` enforce automatically. CI's `bun run verify` catches the
tool-level rules; this file is the home for the human-level ones — patterns
worth enforcing in review, ideally with a check script wired into
`verify:static` so the enforcement becomes structural rather than
aspirational.

Each rule documents:

- The pattern to avoid (the **anti-example**)
- The pattern to use instead (the **good example**)
- The **rationale** — why this rule exists
- The **detection** approach — grep query, lint config, or check script

When you find yourself enforcing a convention in code review more than
once, add it here. When you can express the rule as an automated check,
wire it into `scripts/check-code-style.ts` (or a sibling script) and run
it under `verify:static` so future regressions fail CI, not review.

---

## Imports

### No inline type imports

Never write `import("...").TypeName` in a type position. Use a top-level
`import type { TypeName } from "..."` instead.

```ts
// BAD — looks like a runtime dynamic import.
private _factory:
  | ((wsId: string) => import("../bundles/startup.ts").BundleMcpDeps)
  | null = null;
```

```ts
// GOOD — equivalent at compile (both forms erase), explicit at the top.
import type { BundleMcpDeps } from "../bundles/startup.ts";

private _factory: ((wsId: string) => BundleMcpDeps) | null = null;
```

**Rationale.** The two forms compile to the same JS — TypeScript erases
type-only references in both shapes. The inline form was historically used
to dodge circular-import chains, but type-only imports don't participate in
the runtime module graph (they're erased before the bundler sees them), so
the cycle-avoidance argument doesn't hold. What's left is a syntax that
reads exactly like a runtime dynamic `import()` and trips every reader who
hasn't seen it before. The readability tax isn't worth the shortcut.

**Detection.** `bun run check:code-style` (wired into `verify:static`).

**Override.** None. The rule is absolute; refactor to top-level
`import type` before merge.

---

## Source text

### No raw control bytes

Never embed a raw C0 control byte in source. Write the escape.

```ts
// BAD — a raw NUL byte sits between the quotes (drawn here as the visible
// symbol ␀, since it's invisible in a real editor). tsc, biome, and the tests
// all pass, so nothing catches it.
.join("␀")

// GOOD — an escape. Byte-identical runtime string; the file stays text.
.join("\u0000")
```

**Rationale.** A raw control byte passes `tsc`, biome, and the test suite, but
`rg` / `git grep` classify the whole file as *binary* and silently skip it, and
git's own diff renders it as text only by luck (its binary heuristic scans just
the first ~8 KB). So the artifact ships a byte the diff never showed the
reviewer, and code search over a core file goes dark. The escape yields the
identical runtime string with none of that.

**Detection.** `bun run check:code-style` (wired into `verify:static`) —
flags any byte in 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, or 0x7F under `src/`.

**Override.** None.

---

## Adding a new rule

1. **Pick the smallest possible rule.** One pattern, one example, one
   rationale. Multi-clause rules turn into multi-clause exceptions.
2. **Add a section above** describing the rule with the same shape
   (anti-example, good example, rationale, detection, override).
3. **Wire enforcement.** Extend `scripts/check-code-style.ts` with a
   detection pass. The script aggregates findings across all rules and
   fails the run on any match. CI runs it as part of `verify:static` via
   the `check:code-style` script in `package.json`.
4. **Land all three artifacts in one PR** — the rule doc, the check, and
   the cleanup of any existing violations. Otherwise the rule lands
   without teeth and the next reviewer has to do the cleanup.
