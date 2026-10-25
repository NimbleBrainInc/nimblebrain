# Code Style

Project-specific code-style and quality-control rules that go beyond what
Biome's built-in rules and `tsc` enforce. Each is enforced in review and, where
it can be automated, by a Grit plugin in `biome-plugins/` (run by `bun run
lint`) or a `check:*` script under `verify:static`, so a regression fails CI,
not review.

Each rule documents:

- The pattern to avoid (the **anti-example**)
- The pattern to use instead (the **good example**)
- The **rationale** — why this rule exists
- The **detection** approach — grep query, lint config, or check script

When you find yourself enforcing a convention in code review more than
once, add it here.

---

## Imports

### No inline type imports

Never write `import("...").TypeName` in a type position. Use a top-level
`import type { TypeName } from "..."` instead.

```ts
// BAD — looks like a runtime dynamic import.
private _factory:
  | ((wsId: string) => import("../connectors/runtime/startup.ts").ConnectorMcpDeps)
  | null = null;
```

```ts
// GOOD — equivalent at compile (both forms erase), explicit at the top.
import type { ConnectorMcpDeps } from "../connectors/runtime/startup.ts";

private _factory: ((wsId: string) => ConnectorMcpDeps) | null = null;
```

**Rationale.** The two forms compile to the same JS — TypeScript erases
type-only references in both shapes. The inline form was historically used
to dodge circular-import chains, but type-only imports don't participate in
the runtime module graph (they're erased before the bundler sees them), so
the cycle-avoidance argument doesn't hold. What's left is a syntax that
reads exactly like a runtime dynamic `import()` and trips every reader who
hasn't seen it before. The readability tax isn't worth the shortcut.

**Detection.** The Biome plugin `biome-plugins/inline-type-import.grit`
(run by `bun run lint`) on `src/` and `scripts/`.

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

**Detection.** The Biome plugin `biome-plugins/control-byte.grit` (run by
`bun run lint`) flags any byte in 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, or 0x7F
inside a string, template, or regex literal, a quoted key, a string literal
type, or a JSX attribute string under `src/` and `scripts/`. A Grit pattern
cannot see comments, so a control byte in a comment is left to review.

**Override.** None.

---

## Prompt composition

### Containment tags open only through wrapContained

Fence untrusted content in the system prompt with
`wrapContained(tag, body)` from `src/prompt/containment.ts`. Never write a
containment tag's open, close, or escape by hand.

```ts
// BAD — the escape and the close are written separately and can drift.
const text = `<app-state>\n${body.replaceAll("</app-state>", "")}\n</app-state>`;
```

```ts
// GOOD — the open, the escaped close, and the close all derive from one tag.
const text = wrapContained("app-state", body);
```

**Rationale.** A body that contains its own fence's close tag ends the fence
early, and what follows reads as trusted prompt. `wrapContained` builds the
open, the escape of every close variant in the body, and the close from the
single `tag` argument, so they cannot diverge.

**Detection.** The Biome plugin `biome-plugins/containment-tag.grit` (run by
`bun run lint`) flags any string, template, or regex literal, quoted key,
string literal type, or JSX attribute string under `src/` and `scripts/`
that opens, closes, or escapes a containment tag outside
`wrapContained`. The plugin carries its own copy of the `ContainmentTag`
union, and `test/unit/containment-tag-plugin.test.ts` fails when the two
differ.

**Override.** None.

---

## Public content

### No internal hosts or real WorkOS identifiers

This repo is public. Never write a hosted-platform hostname, a real AuthKit
subdomain, or a WorkOS client id in any tracked file: source, test, fixture,
doc, or script. Use a fictional value, or take a real one at runtime.

```ts
// BAD — a hosted tenant's real host (drawn here with a placeholder for the
// company domain, so this file stays clean under the check).
process.env.NB_PLATFORM_HOST = "acme.<company-domain>";
const PROBE_REDIRECT_URI = "https://<real-tenant>.<company-domain>/v1/mcp-auth/callback";
```

```ts
// GOOD — a fictional host in a test; a real one from the caller at runtime.
process.env.NB_PLATFORM_HOST = "acme.nb.example.com";
const redirectUri = parseRedirectUri(process.argv[3]); // usage error when missing
```

**Rationale.** A public repo is indexed and cloned. A real host in an example
discloses deployment topology and names a customer, and it outlives any later
cleanup in git history. `example.com` (RFC 2606) cannot resolve to anyone's
deployment, so a reader knows at a glance the value is illustrative.

**Detection.** `bun run check:internal-hosts` (wired into `verify:static`)
scans every git-tracked text file for:

- a subdomain of the company domain other than a public site (`docs`,
  `schemas`, `static`, `synapse`, `www`);
- `<subdomain>.authkit.app` where the subdomain is not allow-listed;
- the WorkOS client-id shape: `client_01` followed by 24 Crockford base-32
  characters.

**Override.** Two allow-lists of exact labels in
`scripts/check-internal-hosts.ts`. `PUBLIC_COMPANY_SUBDOMAINS` holds the
company's public sites; add one only when it serves the public.
`FICTIONAL_AUTHKIT_SUBDOMAINS` holds AuthKit placeholders (`myapp` in the
docs, `testapp` in the tests); add a label only when it is a placeholder in
every use. There is no per-line marker and no file
exemption. For a client id, use a value that breaks the shape (`client_test`).

---

## HTTP routes

### Router middleware is chained per route

A Hono sub-app never calls `.use()`. Chain its middleware on each route.

```ts
// BAD — app.ts mounts this at "/", so requireAuth runs for every request the
// app handles after the mount, including other routers' routes and paths no
// router registered.
return new Hono<AppEnv>()
  .use("*", requireAuth(ctx.authOptions))
  .get("/v1/bootstrap", (c) => handleBootstrap(ctx.runtime, c.var.identity));
```

```ts
// GOOD — the middleware runs for this route alone.
return new Hono<AppEnv>().get("/v1/bootstrap", requireAuth(ctx.authOptions), (c) =>
  handleBootstrap(ctx.runtime, c.var.identity),
);
```

**Rationale.** Hono flattens a sub-app's `.use("*", mw)` into a `/*` matcher
on the parent app. Every router is mounted at "/", so that middleware runs for
every later-matched request: an unregistered path answers 401 instead of 404,
a route mounted after the router authenticates once per such router, and
`errorLog` records errors for routes it does not own. Correctness would then
depend on mount order in `app.ts`. Per-route middleware scopes it to the route
by construction.

**Detection.** The Biome plugin `biome-plugins/router-use.grit` (run by
`bun run lint`) flags any `.use(...)` call in a `.ts` file under `src/` except
`src/api/app.ts`. `test/integration/route-middleware-scope.test.ts` walks the
mounted route table.

**Override.** None. The global middleware in `src/api/app.ts` (tracing,
metrics, CORS, security headers, the cross-site guard) is app-wide by design
and is the only place `.use()` belongs.

### A route's JSON body is a named response type

A route writes a JSON body only through `json<T>()` (`src/api/types.ts`), with
`T` a type from `src/api/schemas/responses.ts`.

```ts
// BAD — the body is described nowhere but here; the web client and the tests
// each write their own copy.
return c.json({ authorizationUrl });
return Response.json({ conversationId });
return json<{ ok: boolean }>({ ok: true });
```

```ts
// GOOD — the named type is the contract the web shell and the tests import.
import type { OAuthInitiateResponse } from "../schemas/responses.ts";

return json<OAuthInitiateResponse>({ authorizationUrl }, 200, { "Set-Cookie": cookie });
```

**Rationale.** A body built inline is described again by every reader: the web
client's hand-written type, a test's local interface. Those copies drift from the
handler the first time it changes, and nothing fails. `responses.ts` is emitted
into `web/src/_generated/api/` by `bun run codegen`, so a changed body fails the
build at the web client and at the tests. `json<T>()` takes `T` as `NoInfer`, so
it does not compile without one.

**Detection.** `bun run check:rest-responses` (wired into `verify:static`) flags,
in any `.ts` file under `src/` outside the platform app UIs: a `.json(...)` call
with an argument (`c.json(body)`, `Response.json(body)`), a
`new Response(JSON.stringify(...))` outside `src/api/types.ts`, and a
`json<T>()` whose `T` is not a name imported from `schemas/responses.ts`.

**Override.** None. Declare the body in `responses.ts`. A body that restates a
domain type (`FileEntry`, `PlacementEntry`) mirrors it there, because
`responses.ts` imports nothing, and `responses-drift-guard.ts` pins the mirror to
its source.

---

## Platform tools

### Platform tool handlers return a named output type

A tool under `src/platform/` is registered with `typedTool`, passing a TypeBox
`outputSchema` from `src/platform/schemas/<app>.ts`, and its handler returns
that schema's static type, never `object`. The full rule is
`src/platform/AGENTS.md` §2.1.

```ts
// BAD — every caller gets an untyped result and re-declares its shape.
async function handleTag(store: FileStore, args: FilesTagInput): Promise<object> {
  return { id: args.id, tags: newTags };
}
```

```ts
// GOOD — the schema is the contract; the handler returns its static type.
import { FilesTagInput, FilesTagOutput } from "../schemas/files.ts";

async function handleTag(store: FileStore, args: FilesTagInput): Promise<FilesTagOutput> {
  return { id: args.id, tags: newTags };
}

typedTool({
  name: "tag",
  description: "Add or remove tags on a file.",
  inputSchema: FilesTagInput,
  outputSchema: FilesTagOutput,
  handler: async (input) => ok(await handleTag(getStore(), input)),
});
```

**Rationale.** A handler's return type is its tool's contract. Declared as
`object`, it checks nothing: callers and tests cast the result to a shape they
write themselves, and those casts drift from the handler the first time it
changes. A named schema in `schemas/` is compiled against the handler,
published on `tools/list`, and through codegen shared with the web client, so a
changed shape fails the build at each consumer.

**Detection.** `typedTool` fails the typecheck when a success result's
`structuredContent` is not the output schema's static type, so a helper typed
`object` cannot feed it while the schema has a required field. (`object` is
assignable to an all-optional object type, so there the SDK client's runtime
check is the guard.) `test/unit/platform/schema-shape.test.ts` fails when a
platform tool publishes no output schema, and the SDK client fails any call
whose result does not match the published one.

**Override.** None. Declare the output schema in `schemas/`; when it mirrors a
domain type the schemas tree cannot import, hold the two together with a
drift guard (`src/platform/files/output-types-drift-guard.ts`).

---

## Lint suppressions

### A biome-ignore states why the rule does not apply here

A suppression's reason names the specific fact that makes the rule wrong at
this line. It never just says the suppression is wanted, and never points at
another comment.

```ts
// BAD — says the suppression is wanted, not why the dependency can be left out.
// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs only on mount
useEffect(() => {
  if (chatId) openPanel(chatId);
}, []);

// BAD — true only while the comment it points at stays put.
// biome-ignore lint/suspicious/noArrayIndexKey: same as above
```

```ts
// GOOD — no suppression: `useEffectEvent` reads the latest `openPanel`
// without making it a dependency.
const openFromUrl = useEffectEvent(() => {
  if (chatId) openPanel(chatId);
});
useEffect(() => {
  openFromUrl();
}, []);

// GOOD — the reason is the fact that makes the extra dependency right.
// biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` moves when the panel's data changes, which is when the stats are re-read
```

Before writing a reason, try removing the need for one. For
`useExhaustiveDependencies`: list a dependency that is stable (a `useCallback`
or memoized result, a state setter); read a value without re-running through
`useEffectEvent`; reset state when a key changes while rendering rather than
in an effect; key a list by something other than its position.

**Rationale.** A suppression switches a check off for one line, so its reason
is the only record of why the check is wrong there. A reason that only
asserts intent cannot be checked against the code, so a stale closure or a
list that started reordering hides behind it until someone re-derives the
reason from scratch.

**Detection.** Review: whether a reason holds takes a reader. Biome refuses a
suppression with no reason at all.

**Override.** None.

---

## Types

### A double cast names its mismatch

Reach a type through a typed path: a type guard, a schema parse, a typed
helper, or the SDK's own input or output type. When none exists, an
`as unknown as T` carries a suppression whose reason names what the value is and
what the code claims it is.

```ts
// BAD — nothing says why the compiler is wrong, or when it stops being wrong.
const { taskId } = args as unknown as { taskId: string };
const stub = { postMessage() {} } as unknown as Window;
```

```ts
// GOOD — a typed path: `typedTool` gives the handler its schema's static type.
typedTool({
  name: "delete",
  inputSchema: TasksDeleteInput,
  handler: async ({ taskId }) => ok(await deleteTask(taskId)),
});

// GOOD — a test double through `stub<T>` (test/helpers/stub.ts): the members
// it shares with `T` are checked against `T`, and the ones left out are absent.
const runtime = stub<Runtime>({ requireWorkspaceId: () => WS });

// GOOD — no typed path, so the reason names the mismatch.
// biome-ignore lint/plugin/double-cast: the app's window, reduced to the `postMessage` the bridge calls
const stub = { postMessage() {} } as unknown as Window;
```

**Rationale.** A cast through `unknown` switches the compiler off for one
value, and nothing records why. A typed path removes the hole: the type comes
from where the value is made or checked (the validator, the schema, the SDK), so
a change on that side fails the build at the use. Where no typed path exists,
the reason is the only record of the mismatch, and it says when the cast can
go: when the SDK types the result, when the stub grows the missing member.

**Detection.** The Biome plugin `biome-plugins/double-cast.grit` (run by
`bun run lint`) flags `x as unknown as T`, `(x as unknown) as T`, and `(x as unknown)! as T`. Biome
refuses a suppression with an empty reason and reports one that no longer
suppresses anything. Whether a reason is true is review's call. The repo has no
`<T>x` assertions, and the plugin does not look for them.

**Override.** The suppression above, on the line directly above the line where
the cast expression starts; a longer explanation may sit above it. The plugin
runs on the paths in its `biome.json` override: `scripts/`, `src/` (the platform
app UIs included), `web/src/`, `test/`, and `web/test/`.

---

### A cast to `never` names its mismatch

`never` is assignable to every type, so `x as never` passes `x` into any slot
unchecked: a double cast in one step. Give the value its slot's type instead;
where the value is deliberately outside that type, suppress with a reason.

```ts
// BAD — the fixture can drift from the type it stands in for, and nothing fails.
runWithRequestContext({ identity: { id: USER } as never }, run);
```

```ts
// GOOD — `makeIdentity` (test/helpers/identity.ts) returns a whole `UserIdentity`,
// so a change to the type fails in one place.
runWithRequestContext({ identity: makeIdentity({ id: USER }) }, run);

// GOOD — the value is outside the type on purpose, and the reason says so.
// biome-ignore lint/plugin/never-cast: a stored tier outside `SkillScope`, which is the input under test
skillProvenanceLabel({ scope: "retired-tier" as never });
```

**Rationale.** The same as for a double cast: the compiler stops checking the
value, and nothing records why. A test fixture cast this way keeps compiling
after the type it imitates changes, so the test goes on exercising a shape the
code no longer receives.

**Detection.** The Biome plugin `biome-plugins/never-cast.grit` (run by
`bun run lint`) flags `x as never` and `x as never[]`. A `never` annotation
(`const xs: never[] = []`, an exhaustiveness check) is not a cast and passes. It
does not look for `x as Array<never>` or a `<never>x` assertion; the repo has
neither.

**Override.** `// biome-ignore lint/plugin/never-cast: <reason>` on the line
directly above the line where the cast expression starts. The plugin runs on
the paths in its `biome.json` override: `scripts/`, `src/` (the platform app
UIs included), `web/src/`, `web/test/`, and `test/`.

---

## Adding a new rule

1. **Pick the smallest possible rule.** One pattern, one example, one
   rationale. Multi-clause rules turn into multi-clause exceptions.
2. **Add a section above** describing the rule with the same shape
   (anti-example, good example, rationale, detection, override).
3. **Wire enforcement.** Add a Grit plugin to `biome-plugins/` and list
   it in a `biome.json` override with the paths it covers; `bun run lint`
   runs it in CI. A rule no syntax pattern can express gets its own
   `check:*` script under `verify:static`.
4. **Land all three artifacts in one PR** — the rule doc, the check, and
   the cleanup of any existing violations. Otherwise the rule lands
   without teeth and the next reviewer has to do the cleanup.
