# 0024. Private extensions live under `ai.nimblebrain/*`, and reuse the spec's schemas

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

The runtime needs a few things MCP does not define yet: a way for a server to
read a resource back out of the *host* rather than take it inline as a tool
argument, a way for a server to declare host-facing metadata on its catalog
entry, and host-owned markers on tool results (ADR-0014).

MCP provides the shape for all of it — `_meta` on the wire, `extensions` in the
handshake, reverse-DNS keys — and provides no guidance about what happens when
what you built privately becomes what the spec standardizes. That transition is
the design constraint. A private extension that diverges from the spec's own
shapes has to be migrated when the spec catches up; one that differs only in the
name is renamed.

## Decision

**One namespace: `ai.nimblebrain/*`.** Every private extension method,
capability key, catalog-metadata key, and result marker is keyed under it —
`ai.nimblebrain/resources/read`, `ai.nimblebrain/host-resources`,
`ai.nimblebrain/connector`, `ai.nimblebrain/host`,
`ai.nimblebrain/skill-activated`. One prefix, one place to grep, and no
collision with another vendor's keys by construction.

**A `_meta` key is one of exactly two kinds, and the kind is decided by what
accepting it from a server would widen.**

- **Accepted from the wire** when it widens nothing. `_meta` is otherwise
  forwarded verbatim so a server's own out-of-band hints reach the engine
  untouched. A marker that makes a host guard *stricter* is in this class: a
  server volunteering "this result does not advance the loop" has only tightened
  the count against itself.
- **Host-owned and stripped** when it widens trust. `hostOwnedMetaStripped`
  (`src/tools/mcp-source.ts`) removes these from every result crossing a real
  transport; only the in-memory arm carries them through (ADR-0022). The
  infrastructure-error marker and the two skill markers are in this class, each
  for a reason recorded where it is declared.

The question — *does accepting this from a server widen anything?* — is asked per
key, at the point the key is added. Nothing enforces it, which is why it is
written down.

**Result schemas reuse the spec's, verbatim.** The host-resources extension
methods (`src/host-resources/methods.ts`) return the standard MCP
`ReadResourceResult` and `ListResourcesResult`. The inbound request schemas are
the standard `resources/{read,list}` shapes with only the method literal swapped
(`src/tools/mcp-source.ts`), so the params shape — uri, cursor, filter — carries
through from the spec-blessed types unchanged. Bundle-supplied filter data rides
in `_meta`, per MCP's convention for extension-carried request data.

Because only the method name differs, an eventual upstream migration is
`s/ai.nimblebrain\///` and nothing else. There is no schema migration to plan,
and no window where a server has to speak both shapes.

## Consequences

- The full private surface is one grep, and every key in it names its owner. A
  reader of a wire trace can tell whose extension they are looking at.
- Standardization is a rename. That is the whole point of reusing the schemas,
  and it is worth the constraint it imposes: a private extension must fit a
  standard result shape, or it is not built this way.
- Fitting the spec's shapes sometimes means carrying data in `_meta` that a
  bespoke schema would have made a first-class parameter. That is the cost, paid
  deliberately.
- The two-kinds rule is a discipline, not a type. A new key added without asking
  the question is a trust widening nothing catches, which is why the rationale
  lives beside each key's declaration rather than only here.
- A server that does not model the extension is unaffected: `extensions` is
  optional and `_meta` is free-form, so the fallback is the pre-extension
  behaviour rather than an error.

## Alternatives considered

- **A bespoke result schema per extension method** — rejected: it makes
  standardization a migration, with a period where both shapes must be served.
- **Several namespaces by subsystem** (`nimblebrain.skills/*`,
  `nimblebrain.hooks/*`) — rejected: more prefixes to know, no collision benefit,
  and the grep stops being one grep.
- **An allowlist of accepted `_meta` keys** — rejected: it breaks the namespace's
  purpose, and maintaining a list of every third-party key is a registry that
  cannot stay current.
- **Trusting the two-kinds rule to convention alone, unwritten** — rejected: the
  strip is one function, and the reason a key is in it is exactly the thing a
  future reader will otherwise delete as redundant.
