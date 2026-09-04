# 0017. Whether the trigger matcher retires

- Status: Proposed
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

## Options

**A. Retire the matcher.** Delete the channel; `triggers` becomes ignored
frontmatter, or an error. Everything `dynamic` reaches the model through
tool-affinity or the catalog. Loses the must-fire guarantee entirely.

**B. Keep it, narrowed to must-fire.** Retain the channel but treat a trigger as
a declaration that this skill is mandatory on a match, not as a relevance hint —
and say so in the authoring guidance and the validator. The failure mode
(over-firing on negation and quotation) becomes the accepted price of
determinism, paid only by skills that asked for it.

**C. Keep it, and fix the sharp edges.** Word-boundary matching instead of bare
substring, all matches instead of first-hit, an explicit ordering rule. This
makes the matcher better at a job the model is still better at, and every
refinement is a step toward reimplementing relevance in string operations.

**D. Replace determinism with a different mechanism.** If the real requirement is
"this guidance is present whenever the topic is in play," the honest expression
may be `always` with the cost that implies (ADR-0010), or a pre-turn
classification step, rather than a phrase list.

## What would decide it

- **Whether the matcher is used at all.** Count skills declaring `triggers`
  across tenants, and how many matcher fires occur per run. A channel nothing
  declares against retires on that fact alone.
- **Precision on the fires that happen.** For each fire, whether the activated
  skill was relevant to the message. A high false-fire rate on negated or quoted
  text is the case for retiring; a clean rate on a small set of deliberate
  compliance skills is the case for option B.
- **Whether the catalog covers the same turns.** For the turns where the matcher
  fired, would the model have activated the same skill from its catalog line? If
  the catalog reaches them, the matcher is redundant. If it misses a specific
  class — the skill that must load even when the model judged it irrelevant —
  that class is the entire remaining justification and should be named in the
  decision.
- **Whether any authored trigger is genuinely must-fire.** A trigger list that is
  really a relevance hint belongs in `description`. Reading the actual declared
  triggers answers whether the guarantee is being used or merely available.
