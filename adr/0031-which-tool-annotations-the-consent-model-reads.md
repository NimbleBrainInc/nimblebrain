# 0031. Which spec `ToolAnnotations` the consent model reads

- Status: Proposed
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

The consent surface is also incomplete by design: the store's own note reserves a
third state for when an agent-pause-and-confirm flow exists. Today there is no
"ask the human" state to route a hint into, so a hint could only widen or narrow
an automatic decision.

The constraint on any answer is fixed and is not itself open. An annotation is
what an *untrusted server says about itself*. The rule already stated in the type
(`src/engine/types.ts`, `src/tools/types.ts`) is that a hint may make the host
*more* careful and never *less*: `readOnlyHint: true` must never relax a check,
because a hostile or careless server would simply declare it. What is open is
which hints tighten what, and where.

## Options

**A. Read nothing; keep annotations display-only.** The consent model stays
operator policy alone, and annotations inform the UI. Honest about the hints
being untrusted, and leaves a destructive tool indistinguishable from a read at
the gate.

**B. `destructiveHint` raises the default to needs-approval, once that state
exists.** A server volunteering that a tool is destructive gets a confirmation
step it did not have to ask for. Strictly tightening, so the untrusted-source
problem does not apply — the worst a lying server achieves is more friction for
itself. Depends on the pause-and-confirm flow landing first.

**C. Read `openWorldHint` as a scope signal.** A tool that reaches an open world
is a different exposure from one that operates on the server's own closed
dataset. Plausible input to a policy default, and the least-defined of the hints
in practice.

**D. Read annotations only for what is surfaced to a human**, never for an
automatic decision: the approval prompt, the connector's tool list, the audit
line. Keeps every automatic decision on operator policy while letting the hints
do the job they are actually good at — telling a person what a tool claims about
itself.

## What would decide it

- **Whether the pause-and-confirm state exists.** B is unimplementable without
  it, and D is the natural shape while it does not exist. This is the gating
  fact.
- **What servers actually declare.** Sample `annotations` across the catalogue:
  how many tools set any hint, how many set `destructiveHint`, and whether the
  ones that do are the ones a human would call destructive. Hints nobody sets are
  not a consent signal; hints that disagree with the tool's obvious behaviour are
  a reason to keep them display-only.
- **Whether a tightening-only reading has a false-positive cost.** If a
  meaningful share of tools declare `destructiveHint` defensively, option B is a
  confirmation prompt on ordinary work, which trains people to click through it —
  which is worse than not prompting.
- **Whether the decision needs to be per-tool at all.** If operator policy on a
  connector already expresses what the hints would, the hints add a second input
  to a decision with one owner, and the question answers itself as A or D.

Whatever is chosen, the tightening-only rule is a constraint on the answer, not
one of the options: no reading of an annotation may relax a check.
