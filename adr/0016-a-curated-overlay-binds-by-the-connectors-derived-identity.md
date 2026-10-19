# 0016. A curated overlay binds by the connector's derived identity

- Status: Accepted
- Date: 2026-09-03
- Serves: manage skills, orchestrate remote MCP

## Context

Three mechanisms associate guidance with a connector, and they bind in
three different places.

A **server-published skill** (ADR-0011) needs no binding at all: the skill is a
resource on the server, so the association is the fact of publication. Its
tool-affinity is scoped to the source's own name: the skill may declare
`tool-affinity` as bare names or globs of the server's own tools, which the
adapter prefixes with `<source>__` (`connectorToolAffinity`,
`src/skills/connector-skills.ts`), and one that declares none is bound to
`<source>__*`. The prefix is also the containment — matching is anchored, so a
declared pattern can only narrow within the server's own tools.

A **curated overlay** (ADR-0013) binds by *identity string*. The overlay repo is
keyed `<identity>/SKILL.md`, and the identity is derived at install by
`connectorSkillIdentity` (`src/connectors/catalog/server-detail.ts`) — the brokered
toolkit slug when the catalog entry names one, otherwise the last dotted segment
of the reverse-DNS server name's first path component. The materialized copy's
tool-affinity is bound to *that install's* namespace the same way: the overlay's
declared bare patterns under `<server>__`, or `<server>__*` when it declares none.

An **authored skill** binds by whatever `tool-affinity` globs its author typed.

So the same relationship — this guidance is about that connector — is expressed
as a derived string in one place, a namespace prefix in another, and an implicit
publication fact in a third. Which of the connector's tools a connector skill
governs is a separate question, answered by the skill's own declared patterns;
this ADR concerns only which connector it belongs to. The derivation is the fragile one: it is a formula
over a name, it can collide across unrelated connectors that happen to share a
last segment, and a connector whose name does not follow the shape it assumes
resolves to an identity no overlay is keyed under. The failure is a silent 404,
which is indistinguishable from "no overlay is curated for this connector."

## Decision

**The derived identity is the contract.** A curated overlay is keyed
by `connectorSkillIdentity`: the brokered toolkit slug when the catalog entry
names one, otherwise the last dotted label of the reverse-DNS server name's
first path component. An overlay author keys the overlay under that string, and
the install fetches `<identity>/SKILL.md` and nothing else.

The derivation is stated once, in `connectorSkillIdentityFrom`, and shared by
every caller. A connector whose name the rule maps wrongly is a bug in the
rule, fixed there: names of the form `io.github.<org>/<server>` derive the org
(#1800).

## Consequences

- No catalog field, skill field or second registry records which overlay belongs
  to which connector. Adding an overlay is adding a file under the right key.
- A miss is silent. A connector whose identity has no overlay and one whose
  identity is derived wrongly look the same at install, so the derivation needs a
  test per name shape the catalog admits.
- Two connectors that derive the same identity share an overlay. Curating one for
  a name shape that can collide means fixing the rule first.

## Alternatives considered

- **Name the overlay on the operator-published catalog entry** — rejected while
  the rule covers the curated set: one more hand-maintained field per entry, and a
  second record of an overlay's existence.
- **Bind from the skill** — rejected: the curated repo would own a relationship
  the catalog also describes, and the install could no longer fetch one file by
  name.
- **No binding; let the model resolve guidance from the catalog line** —
  rejected: guidance the model does not think to ask for never arrives, and
  delivery before a bound tool's first call (ADR-0053) has nothing to key on.
