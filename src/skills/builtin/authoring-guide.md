---
name: authoring-guide
description: Guide for authoring NimbleBrain platform skills (voice, workflow, personal, tool routing). Vendored content shipped with the nb__skills bundle.
metadata:
  version: "1.0.0"
  nimblebrain:
    loading-strategy: dynamic
    priority: 25
    tool-affinity:
      - skills__*
---

# Authoring Skills

You are about to author or reason about a platform skill. Read this before
writing or modifying any skill file. Be decisive and brief — skill content
competes for context window space, and so does this guide.

## The three layers

The platform composes context in three layers. **Layer 1** is vendored
content shipped inside a bundle (this file is Layer 1). **Layer 2** is
per-bundle workspace customization — instructions written through a single
bundle's settings surface, scoped to that bundle's tools. **Layer 3** is
skills — cross-bundle context that loads across the whole agent. The
boundary is vertical (one bundle, deep) versus horizontal (across bundles,
shallow).

## Layer 3 vs Layer 2 — choose first

Before authoring a Layer 3 skill, ask: does this apply to exactly one
bundle's behavior?

- **Yes, one bundle.** Author it as a Layer 2 instruction through that
  bundle's settings / instructions surface — deterministic, scoped, and
  deletable with the bundle. A single-bundle rule in Layer 3 pollutes the
  cross-bundle pool.
- **No — it spans bundles or governs the agent itself** (voice, a personal
  preference, a multi-bundle workflow). Author as a Layer 3 skill.

The default is Layer 2. Layer 3 is for content that has nowhere else to live.

## How a skill loads — `loading-strategy`

Every skill declares exactly one strategy (under `metadata.nimblebrain`):

- **`always`** — always in context (the always-on channel). For voice,
  identity, and durable cross-cutting rules. It pays the context tax on
  every turn, so keep it short — a few hundred words at most.
- **`dynamic`** — loaded on demand (the conditional channel). For
  capability / domain skills (a compliance review, a research workflow). A
  dynamic skill enters context through one of three activation signals:
  - **`description`** — the model reads every skill's name + description in
    the catalog and activates the relevant one. This is the default path, so
    write the description to say **what the skill does AND when to use it**
    (fold in the words a user would actually say). Always available; needs
    no extra field.
  - **`tool-affinity`** — auto-activates when a tool in the active set
    glob-matches an entry. Use for skills bound to specific tools / bundles.
  - **`triggers`** — exact-phrase substring match, for deterministic
    "must-fire" activation (e.g. a compliance skill that must load the moment
    a regulated action is named, rather than relying on the model noticing
    the catalog).

  A `dynamic` skill with no `tool-affinity` and no `triggers` is
  catalog-only: it loads solely when the model activates it on its
  description.

## `tool-affinity` patterns

`tool-affinity` is a list of globs matched against the active tool set:

- `synapse-collateral__*` — any tool from one bundle.
- `synapse-collateral__*` plus `synapse-research__*` — across bundles (the
  sweet spot for a workflow skill).
- `*__patch_source` — a specific tool name across bundles. Use sparingly.
- `*` — every tool. Almost always wrong; if you mean "always," use
  `loading-strategy: always` instead.

Only three shapes match: `*` (everything), `<prefix>__*` (starts-with), and
`*__<suffix>` (ends-with). Anything else falls back to exact-string match
(usually matches nothing) — list each tool by exact name if you need more.

## Anti-patterns

- **A single-bundle rule as a Layer 3 skill.** Move it to Layer 2.
- **An `always` skill with kilobytes of body.** Make it `dynamic`; reserve
  `always` for short, durable rules.
- **`tool-affinity: ["*"]`.** Be specific, or use `loading-strategy: always`.
- **Putting "when to use it" only in `triggers` / `tool-affinity`, not the
  `description`.** The catalog activates on the description — a thin
  description means the model never reaches for the skill.
- **Restating identity, tool discovery, or core platform context in the
  body.** Those layers compose automatically; add, don't duplicate.

## Frontmatter and example

Standard top-level: `name` (lowercase + hyphens, ≤64) and `description`.
Optional: `license`, and `allowed-tools` (a space-separated string of tools
the skill may **call** — distinct from `tool-affinity`, which is *when to
load*). NimbleBrain config nests under `metadata.nimblebrain`:
`loading-strategy` (required), `priority`, `status`, `tool-affinity`,
`triggers`.

A valid dynamic workflow skill:

```yaml
---
name: proposal-followup-workflow
description: >
  Schedule a follow-up sequence after a proposal is finalized. Use when the
  user finalizes or sends a proposal in synapse-collateral.
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 50
    tool-affinity:
      - synapse-collateral__*
      - synapse-research__*
---

When the user finalizes a proposal with synapse-collateral, draft a follow-up
plan using synapse-research and confirm the schedule before sending. Do not
start the sequence until the proposal is marked sent.
```

This validates: `name` is lowercase-and-hyphens, the `description` says what
the skill does and when to use it, and `metadata.nimblebrain.loading-strategy`
is `dynamic` with a populated `tool-affinity`.

## Authoring checklist

1. The content belongs in Layer 3 — it spans bundles or governs the agent,
   not a single-bundle rule.
2. `loading-strategy` matches the content — `always` for short durable
   rules, `dynamic` for everything else.
3. For `dynamic`: the `description` states **when** to use it; add
   `tool-affinity` and/or `triggers` only if you need auto / deterministic
   activation.
4. Body size matches the strategy — `always` stays short.
5. Instructions in second person; no restated identity or tool discovery.
6. `priority` is in the operator range (11–99; 0–10 is reserved for core).
