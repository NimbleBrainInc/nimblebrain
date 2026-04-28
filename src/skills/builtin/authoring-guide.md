---
name: authoring-guide
description: Guide for authoring NimbleBrain platform Layer 3 skills (voice, workflow, personal, tool routing). Vendored Layer 1 content shipped with the nb__skills bundle.
version: 1.0.0
type: context
priority: 25
scope: bundle
loading-strategy: tool_affined
applies-to-tools:
  - skills__*
metadata:
  category: platform
  tags: [skills, authoring, platform]
---

# Authoring Layer 3 Skills

You are about to author or reason about a platform skill. Read this before
writing or modifying any skill file. Be decisive and brief — skill content
itself competes for context window space, and so does this guide.

## The three layers

The platform composes context in three layers. **Layer 1** is vendored
content shipped inside a bundle (this file is Layer 1) — immutable to the
operator, owned by the bundle author. **Layer 2** is per-bundle workspace
customization — instructions written through a single bundle's settings
surface, deterministic and scoped to that bundle's tools. **Layer 3** is
skills — cross-bundle context that loads intelligently across the whole
agent. The boundary is vertical (one bundle, deep) versus horizontal
(across bundles, shallow). If a customization belongs to one bundle, it
is Layer 2. If it spans bundles or governs the agent itself, it is
Layer 3.

## Layer 3 vs Layer 2 — choose first

Before authoring a Layer 3 skill, ask: does this customization apply to
exactly one bundle's behavior?

- **Yes, one bundle.** Stop. Author it as a Layer 2 instruction through
  that bundle's settings or instructions surface. Layer 2 is
  deterministic, scoped, and deletable with the bundle. Putting a
  single-bundle rule in Layer 3 pollutes the cross-bundle pool and
  invites contradiction.
- **No, it spans bundles, or governs the agent itself (voice, personal
  preference, multi-bundle workflow, override of a vendored rule).**
  Author as a Layer 3 skill. Continue with this guide.

The default is Layer 2. Layer 3 is for content that has nowhere else to
live.

## Type taxonomy

A Layer 3 skill must fit into one of four operational types. The type
determines tone, scope, and loading strategy:

- **voice** — phrasing, tone, vocabulary, formatting rules. Cross-bundle
  by definition. Loaded `always`. Keep small.
- **workflow** — orchestration steps that span multiple bundles
  ("when synthesizing a follow-up, use bundle A then bundle B"). Loaded
  `tool_affined` so it only enters context when those bundles are in
  scope.
- **personal** — single-user preferences ("call me by my first name",
  "default to metric units"). Cross-cutting. Loaded `always`. Tiny.
- **tool_routing_override** — explicit override of a vendored Layer 1
  rule from a bundle. Must declare an `overrides` block. Loaded
  `tool_affined` against the bundle being overridden.

If your content does not fit one of these, you are probably authoring
Layer 2 in the wrong layer. Go back and check.

## Loading strategy

Pick the strategy that matches what the content costs to keep loaded:

- **always** — small, durable, cross-cutting. Voice and personal
  preferences. The body must stay short, because it pays the context
  tax on every turn. If you are tempted to write more than a few hundred
  words, switch to `tool_affined`.
- **tool_affined** — loads only when at least one tool in the active
  tool set glob-matches an entry in `applies_to_tools`. Workflows and
  routing overrides go here. Requires `applies_to_tools` to be
  populated with at least one specific glob.
- **retrieval** and **explicit** — these exist in the schema for future
  expansion. Do not use them right now. The loader will accept the value
  but will not select the skill.

The implicit default: a skill of `type: context` with no
`applies_to_tools` is treated as `always`. A skill with
`applies_to_tools` set is treated as `tool_affined`. Make the choice
explicit anyway — the next reader should not have to derive it.

## `applies_to_tools` patterns

`applies_to_tools` is a list of glob strings matched against the active
tool set. The conventional pattern is the bundle prefix glob:

- `synapse-collateral__*` — match any tool from one bundle. Almost
  always wrong as a sole entry: a single-bundle rule is Layer 2.
- `synapse-collateral__*` plus `synapse-research__*` — match across
  multiple bundles. This is the sweet spot for a workflow skill.
- `*__patch_source` — match a specific tool name across all bundles
  that expose it. Use sparingly.
- `*` — match every tool. Almost always wrong. If you mean "always
  load," use `loading_strategy: always` and drop `applies_to_tools`.

Be specific. The point of tool affinity is to keep your skill out of
context when its bundles are not in play.

Only three pattern shapes are matched: `*` (everything), `<prefix>__*`
(starts-with), and `*__<suffix>` (ends-with). Anything else — including
embedded wildcards like `*__patch_*` — falls back to exact-string match
against the literal pattern, which usually means it matches nothing and
your skill silently never loads. If you need richer patterns, list each
target tool by exact name instead.

## Overrides — the contradiction-prevention mechanism

A Layer 3 skill that contradicts a Layer 1 vendored rule on tool
semantics MUST declare an `overrides` block. The block names the bundle
and the specific vendored skill being overridden, and gives a human-
readable reason. Without `overrides`, the bundle's rule wins on conflict
and your skill is treated as advisory — meaning the agent may simply
ignore it.

Be explicit when overriding. Silent contradiction is a bug, not a
feature. Examples of when you need `overrides`:

- A bundle's vendored skill says "auto-approve patches under 10 lines";
  your workspace requires manual review for every patch.
- A bundle's voice guidance contradicts a workspace voice rule.
- A workflow skill instructs the agent to skip a step that a vendored
  bundle skill marks as required.

`priority` is not a substitute. `priority` orders skills *within a
layer*; `overrides` is the only mechanism for declaring precedence
*across* layers.

## Anti-patterns

- **Authored a single-bundle rule as a Layer 3 skill.** Move it to
  Layer 2 — write it through the bundle's instructions surface.
- **Contradicted a vendored bundle skill without `overrides`.** Add an
  `overrides` block naming the bundle and skill, with a one-sentence
  reason.
- **Embedded tool-routing rules in a `voice` skill.** Split them out
  into a separate `tool_routing_override` skill with proper
  `applies_to_tools` and `overrides`.
- **Used `priority` to fight cross-layer precedence.** Priority orders
  within a layer only. Use `overrides` to declare precedence across
  layers.
- **Authored an `always`-loaded skill with kilobytes of body.** Move
  the long content to a `tool_affined` skill; reserve `always` for
  short, durable, cross-cutting rules.
- **Set `applies_to_tools` to `*`.** Almost always wrong — be specific.
  If you really want every turn, use `loading_strategy: always` with a
  short body.
- **Restated identity, tool discovery, or core platform context in the
  body.** Those layers compose automatically. Your skill should add,
  not duplicate.

## Frontmatter schema and example

Required fields: `name`, `description`, `version`, `type`, `priority`.
Optional but typically present for Layer 3: `scope`, `loading_strategy`,
`applies_to_tools`, `status`, `overrides`, `metadata`.

A minimal valid Layer 3 workflow skill:

```yaml
---
name: proposal-followup-workflow
description: After a proposal goes out via collateral, schedule a follow-up sequence in the research bundle.
version: 1.0.0
type: skill
priority: 50
scope: workspace
loading-strategy: tool_affined
applies-to-tools:
  - synapse-collateral__*
  - synapse-research__*
status: active
metadata:
  category: workflow
  tags: [proposal, followup]
---

When the user finalizes a proposal with synapse-collateral, immediately
draft a follow-up plan using synapse-research and confirm the schedule
before sending. Do not start the follow-up sequence until the proposal
is marked sent.
```

The example above parses cleanly: `name`, `description`, `version`,
`type`, and `priority` are all present and well-typed; the strategy
matches the populated `applies_to_tools`; the body gives the agent
a single, decisive instruction.

## Authoring checklist

Before saving any Layer 3 skill, confirm each of:

1. The customization actually belongs in Layer 3 — it spans bundles or
   governs the agent itself, and is not a single-bundle rule.
2. The `type` matches the content — voice, workflow, personal, or
   tool_routing_override, with no mixing.
3. `loading_strategy` and `applies_to_tools` agree — `always` has no
   tool list; `tool_affined` has at least one specific glob.
4. If the skill contradicts any vendored bundle rule, an `overrides`
   block is present with bundle, skill, and reason.
5. Body size matches the strategy — `always` skills stay short;
   `tool_affined` skills can be longer but still focused.
6. The body gives instructions to the agent in second person, with no
   restated identity, tool discovery, or marketing.
7. `priority` is in the documented operator range and is not being
   used to simulate cross-layer precedence.
