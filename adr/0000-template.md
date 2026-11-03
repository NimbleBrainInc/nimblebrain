# ADRs: the convention and the template

An ADR records a decision: why it is this way, and what was rejected. It is
valuable because it does not change. A spec says what is true now, and is
valuable because it is current. Each document does one of those jobs.

## When to write one

Write an ADR only for a choice that is expensive to reverse or likely to be
proposed again. Anything smaller is a paragraph in the spec or the guide.

## The spec owns the contract

The current rule lives in the area's living spec, updated in the same PR as the
behaviour. Git is its history.

- Anything an app or server author reads: a public page under `docs/`.
- A host-internal rule: the `AGENTS.md` guide beside the code.

When an ADR and a spec disagree, the spec is right about what is true now.

## Status

- **Proposed** is edited in place, title and file name included. It may carry the
  full design while nothing is built.
- **Accepted** is frozen. Only its status line changes. It means the decision is
  implemented and its contract is in the spec.
- **Superseded by ADR-NNNN** names its successor. A decision that is reversed gets
  a new ADR, which names the one it replaces in `Supersedes`, and the old ADR's
  status line changes. A new ADR that reverses only part of an old one restates
  the part that stands, so the old one is superseded whole.

A change to a rule that leaves the decision standing goes in the spec. It does not
touch the ADR and needs no note there.

## The trim on acceptance

The PR that lands the decision also moves its contract into the spec, sets the
status to Accepted, and trims the ADR to five parts:

1. Context: the forces.
2. Decision: a sentence or two.
3. Consequences.
4. Alternatives considered: what was rejected, and why.
5. Spec: a link to the section that holds the contract.

Write rules, pipelines, schemas, and threat tables do not survive the trim; they
are the contract. A decision that changes no code, such as a refusal to build
something, still states its rule in the spec and links to it.

## Threats

Threats and their defences go in a security section of the area's spec, updated in
the same PR as the defences, and not in a table in an ADR, because defences change
while a decision stands.

## ADRs accepted before this convention

This convention governs every ADR accepted after
[ADR-0061](./0061-a-living-spec-owns-the-contract-and-an-adr-records-the-decision.md).
Earlier ADRs stay as written, their `Amended by` notes included, and are not
retrofitted. A first change to an area with no spec section writes that section.

## Template

Copy this into `adr/NNNN-<title>.md`, using the next free number. Who approved is
recorded by the PR, so an ADR has no participant list.

```markdown
# NNNN. <Title — imperative, e.g. "Files resolve by bare id">

- Status: Proposed | Accepted | Superseded by ADR-XXXX
- Date: YYYY-MM-DD
- Serves: <which golden rule(s) — manage skills / orchestrate remote MCP / secure RBAC>
- Spec: <required once Accepted: a link to the spec section that holds the contract>
- Supersedes: <only if this replaces an Accepted ADR: a link to it>

## Context

The forces at play — what's true, what pressure created the decision. Present
tense. Keep internal-only specifics (client/engagement origins, prod metrics,
private infra names) out of this file; the principle belongs here, the numbers
stay in the private design doc.

Every claim here and below should name a **mechanism**, not count today's
instances of one: "`startRun` owns the membership gate" survives a refactor that
moves callers around it; "the two surfaces that gate membership" does not.
Transcribing a roster, a method signature, or a count dates the ADR to the day it
was written — unless the count *is* the decision.

## Decision

What we chose, stated in the present tense as a standing rule. Once Accepted, a
sentence or two; the detail is in the spec.

## Consequences

What this makes easy, what it makes hard, what it forecloses. Be honest about
the cost.

## Alternatives considered

What we rejected and why — one line each.
```
