# 0061. A living spec owns the contract and an ADR records the decision

- Status: Accepted
- Date: 2026-11-02
- Serves: manage skills, orchestrate remote MCP, secure RBAC
- Spec: [`adr/0000-template.md`](./0000-template.md)

## Context

A decision record is valuable because it does not change; a spec is valuable
because it is current. An ADR asked to do both gathers amendment notes and grows
into a spec, so learning a current rule means merging several ADRs by hand. The
repo already keeps living documents edited in place: `docs/` for the public
contract and the `AGENTS.md` guides for host-internal rules.

## Decision

The contract lives in the area's living spec, threats and defences included. An
ADR is written only for a choice that is expensive to
reverse or likely to be proposed again; once Accepted it is trimmed to a short
record and frozen except for its status line.

## Consequences

A current rule has one place to read. A PR that lands a decision also moves its
contract, so acceptance takes more work than flipping a status. A frozen ADR's spec
link can go stale when the spec moves; `git log --follow` finds the page. Earlier
ADRs keep their amendment chains until a change to each area writes its spec.

## Alternatives considered

- Keep amending ADRs: the amendment chains are the problem being solved.
- Edit Accepted ADRs in place: it loses the record of what was decided and when.
- Add a separate `spec/` tree: `docs/` and the guides already hold the contract, and
  a second home would drift from them.
- Keep threat tables in ADRs: defences change while a decision stands, and a frozen
  table goes stale.
- Give threat models their own documents: a second place to keep current, when the
  spec's security section already holds them.
- Retrofit existing ADRs: it rewrites the record and tells no reader anything new.
