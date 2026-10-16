# 0053. A bound skill reaches the model before its tool's first call

- Status: Accepted
- Date: 2026-10-14
- Serves: manage skills

## Context

A skill that declares `tool-affinity` claims to govern those tools. It holds
the rules for drafting an email or for writing a record, and those rules are
worth most on the first call, which is where a model that has not read them
goes wrong.

Two channels delivered such a skill, and neither keyed on that call.

**Turn-start selection keyed on presence.** It composed every `dynamic` skill
whose affinity matched a tool in the turn's direct set into the cached system
prompt. Several things make a tool direct without the job being at hand:
- focusing an app promotes all of its tools;
- the `tasks` identity source is always direct;
- a small workspace has every tool direct.

So a greeting in a focused app composed every skill its bundle ships, and the
core task-authoring guide rode every turn of every conversation. The section
also sits in the stable prefix and changes with the tool set (ADR-0018).

**The surface-once backstop keyed on use, but too late.** It fired at
`tool.start`, let the call execute, and delivered the body after the
iteration's tool results. The guidance arrived after the call it was written
for. Its candidates were connector skills only, so a workspace skill bound to a
connector's tool was never delivered on use.

## Decision

**A skill bound to a tool is in context before that tool first runs in the
conversation.** The engine's per-call gate enforces this for every run, chat
and task alike. It reads only what the skill already declares, so no
frontmatter field is added.

**Holding the first call.** When the model calls a tool before a skill bound to
it has been delivered:
- The call does not run. It returns an error result with reason
  `skill_guidance_pending` naming the skills.
- The bodies follow it as a `user` message after the iteration's tool results,
  which is where replay already places a delivered body.
- The model calls the tool again, and that call runs.

The hold sits after input validation and the supervisor's repeat refusal, and
before the `beforeToolCall` hook. A person is never asked to approve a call
that is then held.

**Promotion is the free path.** Promoting a tool delivers the skills bound to
it, so for a proxied tool the guidance is in context before the call, with no
hold. A hold fires only where nothing preceded the call: a focused app's tools,
kernel tools, a small workspace's tools, or a promotion and a call sent in the
same message.

**One candidate set for every source.** Candidates are every active `dynamic`
skill with `tool-affinity`:
- core, org, workspace and user skills;
- server-published skills;
- curated overlays.

A tenant's skill bound to a bundle's tool is held for on the same call as the
bundle's own skill. A skill the turn already composed is left out: one picked by
turn-start selection, one the trigger matched, or the `<app-guide>` skill.

**What a hold is, in every record.** A held call ran nothing, and no record may
say otherwise.
- `tool.done` and the tool-call record carry `held: true` and `ok: false`. They
  carry no UI binding, so no app view mounts.
- The call skips `afterToolCall`, the loop supervisor, and the promoted-tool LRU.
- The web chat leaves it out; the re-issue is the call shown.
- A task run does not count it as a call or a failure. The exception is a run
  that stopped short (any stop but `complete`) before re-issuing it: that one
  counts as unrecovered, because its work never happened.

**Bounds.**
- **Per skill:** a skill holds at most once per run.
- **Per hold:** one hold delivers at most three skill bodies' worth
  (`3 × MAX_SKILL_BODY_CHARS`), lowest priority number first. Any further skills
  are named for `nb__use_skill` and not held for again.
- **Parallel calls:** calls in one message bound to the same skill share its one
  fetch.
- **No body arrived:** the call runs.
- **Near the iteration limit:** still hold, rather than run a governed call
  unguided.

**Read-only waives only the server's own default.** A server's skill bound to
its whole namespace (`<server>__*`, declared or defaulted) does not hold the
first call to a tool its server annotates `readOnlyHint`. It is delivered right
after that call, before the model's next action. Every skill that names its
tools holds whatever the annotation says, as does every skill from another
source. The annotation is the server's claim about itself, so it may relax only
that server's own binding (`executor.ts`, `unresolvedFailures`).

**Every gap is recorded.** `skill.not_delivered` records:
- `fetch_failed`, a body that could not be fetched;
- `capped`, a skill a hold's size cap left out;
- `renamed_unheld`, a call a hook renamed past the hold.

The load ledger reads a held delivery as `before_call` and a gap as a row with
`status`.

## Consequences

- The first `draft_email` of a conversation is written under its guidance, in
  chat and in an unattended run, without the model choosing to load anything.
- A held call costs one extra model call, once per skill per conversation, and
  only where no promotion preceded it. That is the price of guidance arriving
  before the call. An author who does not want it binds no tools: the skill is
  then catalog-only, loaded when the model asks.
- A skill bound to `<server>__*` by default holds the first non-read call to any
  of its server's tools. A bundle that ships several workflow skills should
  give each the tools it governs (#1467).
- The platform's own `authoring-guide` binds `skills__create` and
  `skills__update`, not `skills__*`, so muting or reading a skill is not held
  for the authoring guide.
- Turn-start selection now only duplicates this rule, for tools that happen to
  be direct. Removing it (#949) empties the stable prefix of job bodies and
  settles ADR-0018. It is gated on a staging reading of how often models
  re-issue a held call.

## Alternatives considered

- **An opt-in `before-call` field per skill.** Rejected because a skill that
  declares the tools it governs has already said its guidance belongs before
  them. Delivering it after the call is never the right reading, and a field
  would only let an author choose the wrong one.
- **Bodies inside the held result.** Rejected. The activation marker records
  one skill per message. And an app tool's text past 50,000 characters is
  swapped for a pointer, so the bodies would not reach the model.
- **Narrowing turn-start selection to tools that are direct by budget.**
  Rejected because it moves the symptom. A focused drafting turn would get less
  guidance than before, and the first call would still run before its guidance.
- **Model-only delivery** (catalog and `nb__use_skill`, no deterministic path).
  Rejected because it puts an unattended run's correctness on the model
  choosing to activate. That rate has not been measured.
