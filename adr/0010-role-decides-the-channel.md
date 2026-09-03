# 0010. A skill's role decides its prompt channel

- Status: Accepted
- Date: 2026-09-03
- Serves: manage skills

## Context

Guidance reaches the model through several channels with different costs and
different reliability. Content composed into the system prompt is present on
every model call of a run and rides the cached prefix; content selected once at
turn start is present for that turn only; content matched per message arrives
late and cheaply; content that is merely listed costs a line and arrives only if
the model asks for it.

Something has to decide which channel a given skill takes. The decision must be
the same everywhere — the composer, the selector, the matcher, and the tools that
report a skill's status all have to agree, or the runtime tells an author their
skill will load and then does not load it.

The tempting place to put that decision is the call site: the composer picks up
`always` skills, the selector picks up ones with tool-affinity, the matcher picks
up ones with triggers. That is three independent readings of the same
frontmatter, and it produces skills that enter two channels at once and skills
that enter none while nothing says so.

## Decision

**A skill's declared role — `loading-strategy` plus the selection signals it
carries — determines its channel, by construction, in one place per decision.**

`partitionSkillsByRole` (`src/skills/select.ts`) is the routing authority. It
splits a pool into two disjoint sets on `loading-strategy` alone:

- **`always` → the context channel.** Composed into the system prompt every
  turn, sorted by priority. This is identity and voice: content that is wrong to
  make conditional.
- **`dynamic` → the capability channels.** Content that costs nothing when the
  turn does not need it.

The two sets are disjoint by construction, so a skill can never enter both and
there is no downstream de-duplication to get wrong.

Within `dynamic`, the signals decide which capability channel reaches the skill,
in this precedence:

1. **Tool-affinity → turn-start selection.** `selectLayer3Skills`
   (`src/skills/select.ts`) matches the skill's `tool-affinity` globs against the
   active tool set once, at turn start, and composes what matched.
2. **Triggers → per-message matching.** `SkillMatcher` (`src/skills/matcher.ts`)
   substring-matches the message against the skill's `triggers`, first hit wins.
   This is the deterministic must-fire channel: a phrase the author will not
   accept the model missing.
3. **Neither → catalog-only.** The skill is listed and the model activates it by
   name (ADR-0015).

The two `dynamic` signals are orthogonal, not exclusive: a skill with both is
reachable by tool-affinity *and* by an explicit phrase, and the phrase fires even
when the publishing source's tools are not in the active set. Triggers on an
`always` skill are inert — the matcher only sees `dynamic` skills, and an
`always` skill is already composed every turn.

**The precedence is stated once as a pure predicate.**
`resolveLoadingMechanism` (`src/skills/loading.ts`) mirrors the routing above and
is the sole answer to "how would this skill load?" — so `skills__list`,
`skills__read`, and the create-confirmation all report the mechanism the loader
will actually use, and a skill with no reaching channel is *visible* as such
rather than silently inert.

## Consequences

- An author declares intent, not a mechanism. Changing which channel a skill
  takes is a frontmatter edit, not a code change.
- A skill can be inert — `dynamic`, no affinity, no triggers — but never
  invisibly so: the read surfaces name the mechanism as none.
- The disabled toggle is honoured per channel, at that channel's own gate: the
  context channel drops disabled skills at partition, the matcher filters them at
  load, and the catalog omits them.
- The precedence has a cost: a `dynamic` skill with tool-affinity is selected at
  turn start against the tool set as it stood then. A tool promoted into the set
  later in the run does not retroactively pull its skill in. An author who needs
  a guide present regardless declares `always` and pays for it every turn.
- Turn-start selection composes into the system prompt, so what it selects moves
  the prompt's cached prefix. The interaction between the channels and the cache
  breakpoints is not settled — see ADR-0018.

## Alternatives considered

- **Per-call-site routing** — rejected: three readings of the same frontmatter,
  guaranteed to diverge, and no single answer to give an author about what their
  skill will do.
- **A separate `channel:` field naming the mechanism directly** — rejected: it
  makes the author responsible for the runtime's internal layering, and it can
  contradict the signals beside it (`channel: trigger` on a skill with no
  triggers).
- **Letting a skill occupy several channels and de-duplicating later** —
  rejected: de-duplication is a second routing rule, and the failure mode is
  paying for the same body twice in one prompt.
