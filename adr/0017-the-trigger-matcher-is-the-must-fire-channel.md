# 0017. The trigger matcher is the must-fire channel

- Status: Accepted
- Date: 2026-09-03
- Serves: manage skills

## Context

`SkillMatcher` (`src/skills/matcher.ts`) is the per-message channel: a
case-insensitive substring scan of the user's message against each `dynamic`
skill's `triggers`, first hit wins, at most one skill per message. What it
matches composes into the prompt as volatile content, evicted from the cached
system prefix onto the latest user message.

Its justification is determinism. A trigger is an explicit phrase an author will
not accept the model missing — a compliance rule that must fire whenever the user
names a regulated action, regardless of what the model judges relevant. Neither
of the other `dynamic` channels gives that: tool-affinity fires on the tool set,
not on what was said, and the catalog (ADR-0015) fires on the model's judgment.

Its cost is that it is a keyword matcher competing with a language model at
relevance. Substring matching has no notion of negation, of quoting, or of
subject: a message saying "don't refund this" fires the refund skill, and so does
one quoting an error string. First-hit-wins means the ordering of the pool
decides which of two matching skills the user gets, and nothing orders that pool
for this purpose. One match per message means a genuinely two-topic message gets
one of its skills.

The catalog covers most of the ground the matcher was built for. The Agent Skills
standard folds keywords into `description`, and the model activates from the
catalog on that — which is the same job done by the component that can read the
sentence.

## Decision

**A trigger declares that a skill must load when its phrase appears. It is not
a relevance hint.** The matcher stays, narrowed to that job:

- `SkillMatcher` scans the run's message against the `triggers` of every active
  `dynamic` skill in the run's pool and of the workspace's server-published
  skills. A connector's skill declares `triggers` in the same frontmatter field,
  so a phrase fires whether or not that server's tools are in the active set.
- First hit wins, one skill per message. The pool puts the workspace's own
  skills before connector skills, so a workspace skill wins a phrase a
  connector also claims.
- The authoring guide and the skill read surfaces describe `triggers` as
  must-fire. Keywords that only describe what a skill is about belong in
  `description`, where the model activates from the catalog (ADR-0015).

Over-firing on negated or quoted text is the accepted price of determinism, paid
only by skills that declare triggers.

## Consequences

- An author who needs a skill loaded regardless of the model's judgment has a
  channel for it, short of `always` and its every-turn cost (ADR-0010).
- A trigger list used as a relevance hint over-fires, and nothing refuses it.
  The guidance is the only guard.
- A two-topic message gets one triggered skill. A second must-fire skill on the
  same message waits for a message that names only it.

## Alternatives considered

- **Retire the matcher** — rejected: it removes the only guarantee that a
  compliance skill loads on its phrase whatever the model judges.
- **Fix the sharp edges** (word boundaries, all matches, an ordering rule) —
  rejected: each refinement reimplements relevance in string operations, a job
  the model does better through the catalog.
- **Replace phrases with `always` or a pre-turn classifier** — rejected: `always`
  pays every turn for a rule needed on a few, and a classifier is a model call
  standing in for one the main model already makes.
