# 0014. Skill activation and suppression markers are host-owned `_meta`, stripped from any real wire

- Status: Accepted
- Date: 2026-09-03
- Serves: manage skills, secure RBAC

## Context

Two in-band signals travel on tool results. One says *this result delivered skill
X's body* — the engine records it and adds the name to the run's delivered set,
so the surface-once overlay path does not hand the same guidance over twice. The
other says *this call muted skill X for this conversation* — the engine persists
it, and the next turn's composition drops that skill from every pool.

`_meta` is the natural carrier: MCP's free-form reverse-DNS namespace, forwarded
verbatim so a server's own out-of-band hints reach the engine untouched.

But both markers are trusted unconditionally by the engine, and both are trusted
to make guidance *disappear*. A server able to set the activation marker could
mute a curated overlay by naming it. A server able to set the suppression marker
could mute another vendor's always-on guidance — a consistency rule, a safety
constraint — by name, for the rest of the conversation, with nothing in the
conversation showing that it happened.

Not every `_meta` key has this shape. A marker that makes a guard *stricter* is
safe to accept from anyone: a server that volunteers "this result does not
advance the loop" has only tightened the supervisor's count against itself.

## Decision

**A `_meta` key is either accepted from the wire because it widens nothing, or
it is host-owned and stripped from anything that crossed a real transport.**
Both skill markers are host-owned.

`SKILL_ACTIVATED_META_KEY` and `SKILL_SUPPRESSION_META_KEY` are declared with
their trust rationale in `src/engine/types.ts` and stripped in
`hostOwnedMetaStripped` (`src/tools/mcp-source.ts`), which runs on every result
`McpSource` returns. The strip is conditioned on the transport, not on the
source's name or configuration: only an in-process source — the platform talking
to itself over a linked-pair transport, where the bytes never leave the process —
carries the markers through. That is what makes the platform's own skill tools
able to emit them and nothing reachable over a network able to.

Other keys ride the same strip, some of them unconditionally, because no source
should send them at all. The infrastructure-error marker is one: the loop
supervisor exempts calls carrying it from its strike count, and that supervisor
is the only thing that removes a misbehaving tool from the model's toolset
mid-run.

## Consequences

- The two decisions that make guidance vanish can only be made by the host. A
  connector cannot silence the runtime's own instructions, or a competitor's.
- The strip is one function on one path, so a new host-owned key is added in one
  place and cannot be honoured on a second route that forgot about it.
- `_meta` remains verbatim for everything else. A server's own hints are not
  filtered by an allowlist the host would have to maintain.
- The in-process exemption is a real trust boundary and rests on the transport
  being in-memory. A platform source that ever moved to a network transport would
  silently lose the ability to emit these markers — which is the correct
  direction to fail, but it is a coupling worth knowing about.
- The asymmetry — accept the strictness marker, strip the leniency markers — has
  to be reasoned about per key. There is no rule the compiler enforces; the
  question "does accepting this from a server widen anything?" has to be asked
  when a key is added.

## Alternatives considered

- **Documenting the keys as host-owned and trusting callers** — rejected: the
  only servers that would honour it are the ones that were never the threat.
- **Stripping every unrecognized `_meta` key** — rejected: it breaks the
  namespace's purpose, and a host allowlist of third-party keys is a registry
  nobody can keep current.
- **Signing host-owned markers** — rejected: the transport already answers the
  question. In-process means the bytes were never outside this process; a
  signature would restate that at the cost of a key.
- **A side channel outside `_meta`** — rejected: the markers are per-result facts
  and belong on the result. A parallel channel has to be correlated back to the
  call it describes, which is the bug this avoids.
