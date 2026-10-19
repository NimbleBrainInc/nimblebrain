# 0031. The consent model reads no tool annotation

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP, secure RBAC

## Context

MCP defines a closed set of behavioural hints on a tool: `title`,
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. They
travel — `McpSource` maps `annotations` off every `tools/list` response into a
field of its own, distinct from `_meta`, and dropping either namespace at that
seam would be silent (`fetchToolList`, `src/tools/mcp-source.ts`).

Nothing downstream reads them for a consent decision. `PermissionStore`
(`src/permissions/permission-store.ts`) holds per-tool policy — `allow` or
`disallow`, defaulting to allow — set by an operator, and `assertToolAllowed` is
the dispatch gate. A tool that declares `destructiveHint: true` is treated
exactly like one that declares nothing.

The consent surface has no "ask the human" state: the store's own note reserves
one for when an agent-pause-and-confirm flow exists. Without it, a hint could only
widen or narrow an automatic decision.

An annotation is what an *untrusted server says about itself*. The rule stated in
the type (`src/engine/types.ts`, `src/tools/types.ts`) is that a hint may make the
host *more* careful and never *less*, because a hostile or careless server would
simply declare whatever relaxes it.

## Decision

**Consent and tool policy read no annotation.** Whether a tool may run is
operator policy alone (`PermissionStore`, enforced by `assertToolAllowed`). A
tool declaring `destructiveHint: true` is gated exactly like one declaring
nothing. Annotations travel with the tool so that a surface showing a person what
a tool claims can read them.

**No annotation relaxes consent or policy.** The one place the host acts on a
hint is guidance delivery: a server's `readOnlyHint` waives the hold that only
that server's own whole-namespace skill binding would place on the call
(ADR-0053). That is the server relaxing a default it set for itself; it reaches
no operator decision and no other source's skill.

## Consequences

- A destructive tool and a read look the same at the gate. An operator who wants
  them treated differently says so per tool.
- A server cannot buy itself a looser gate by what it declares.
- When a needs-approval state exists, reading `destructiveHint` to raise the
  default to it is the natural next step: it only tightens, so the untrusted
  source is not a risk. That is a new decision when the state lands.

## Alternatives considered

- **`destructiveHint` raises the default to needs-approval** — not available: the
  state it routes into does not exist.
- **`openWorldHint` as a scope signal** — rejected: the least-defined hint in
  practice, and a second input to a decision operator policy already owns.
