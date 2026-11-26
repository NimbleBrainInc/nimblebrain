---
name: authoring-guide
description: Guide for authoring NimbleBrain platform skills (voice, workflow, personal, tool routing). Use when creating, modifying, customizing, deleting, or managing a skill — its behavior, triggers, priority, scope, or allowed-tools. Vendored content shipped with the nb__skills app.
metadata:
  version: "1.2.0"
  nimblebrain:
    loading-strategy: dynamic
    priority: 25
    tool-affinity:
      - skills__create
      - skills__update
    triggers:
      - "create a skill"
      - "new skill"
      - "modify skill"
      - "manage skill"
      - "edit skill"
      - "delete skill"
      - "skills__create"
      - "skills__update"
---

# Authoring Skills

Read this before writing or changing a skill. Skill content competes for the
context window, so be decisive and brief, and so is this guide.

## The tools

- `skills__list` / `skills__read`: see what exists. Always list before changing.
- `skills__create`: write a new skill at org, workspace, or user scope.
- `skills__update`: patch manifest fields or the body. An omitted field keeps its
  value; `null` clears one (`description` takes none). Not `status`: the durable
  off switch is the user's, in Skills settings.
- `skills__delete`: remove one (snapshotted first).
- `skills__activate` / `skills__deactivate`: mute or un-mute for THIS
  conversation only. Nothing is written. If the user wants it off for good, say
  it is theirs to do in Skills settings; never mute and report it done.
- `skills__history` / `skills__restore`: past versions, and putting one back.

**Changing a body names its mode.** `body` without `body_mode` is refused.
`"append"` adds after what is there: what "add a rule" means, and the default.
`"replace"` overwrites the whole body; read it first. A bad replace is
recoverable through `skills__history`, `skills__read {version}`, and
`skills__restore`.

## Skill or connector instruction: choose first

A rule for exactly one connector's behavior belongs in that connector's own
instructions (its settings), scoped to its tools and deleted with it. A skill is
for what spans connectors or governs the agent: voice, a personal preference, a
multi-connector workflow. Default to the connector's instructions.

## How it loads

Set `loading-strategy` under `metadata.nimblebrain`:

- **`always`**: in context every turn. Only for short, durable rules (voice,
  identity); it costs context on every call.
- **`dynamic`**: loaded on demand, by one of:
  - its **`description`**, which the model reads in the catalog. This is the
    main path: say what the skill does **and when to use it**, in the words a
    user would say ("Extract text from PDFs, fill forms. Use when the user
    mentions PDFs or forms."). A thin description is never reached for.
  - **`tool-affinity`**: globs matched against each tool called; the skill
    arrives before the first matching call. Only `*`, `<prefix>__*`, and
    `*__<suffix>` match as globs; anything else is an exact name. `*` is almost
    always wrong: use `always` instead.
  - **`triggers`**: exact phrases for must-fire loading. Two to four, specific
    ("compliance review", not "review").

**You write skills on request; the user makes them load on their own.**
`always`, `tool-affinity` and `triggers` put a skill in front of the model in
later conversations without that conversation choosing it, so the user sets
them in Skills settings. `skills__create`, `skills__update` and
`skills__restore` refuse a write from you that would leave a skill with any of
them, or change a skill that already has one. Save the skill with a strong
description and none of the three, then give the user the exact trigger
phrases or tool-affinity globs to add on the skill's page (or, for `always`,
the text to add as an always-on skill).

## Scope and priority

- **org**: every workspace (org admin). **workspace**: this workspace, the
  default for workflows (workspace admin). **user**: only your conversations.
- Priority: 0–10 is reserved for core; 11–20 high (language, accessibility);
  21–40 medium (tone); 41–60 standard (default 50); 61–99 fallback.

## Tools the skill calls

`allowed-tools` (a space-separated string, `<connector>__*` globs) scopes what
the skill may call; `tool-affinity` decides when it loads. Confirm the tools
exist with `nb__search` (`scope: "tools"`) first; if they are missing, tell the
user to install the app. In the body, describe the capability ("search the CRM
for the contact"), never a tool's name, which changes with how a connector is
installed.

## Frontmatter

Top level: `name` (lowercase and hyphens, at most 64), `description`, and
optional `license` and `allowed-tools`. NimbleBrain fields nest under
`metadata.nimblebrain`: `loading-strategy` (required), `priority`,
`tool-affinity`, `triggers`. Never `status`; a new skill is active.

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

When the user finalizes a proposal, draft a follow-up plan and confirm the
schedule before sending. Do not start the sequence until the proposal is sent.
```

## The body

- Instructions to the agent, imperative and second person ("Always cite section
  numbers"), specific about format.
- Add to what composes on its own; never restate identity, tool discovery, or
  platform context.
- **Keep it under 4,000 characters** (about 1,000 tokens). A body past 8,000 is
  refused, because a loaded skill rides every call of its turn and a small
  model's window cannot carry more. Split a longer one into skills that load
  for different jobs.
- A skill cannot change runtime config (that is `nimblebrain.json`), create
  tools (that needs a connector), or override core identity.

## Anti-patterns

- A single-connector rule as a skill: put it in the connector's instructions.
- An `always` skill with a long body: make it `dynamic`.
- `tool-affinity: ["*"]`: be specific, or use `always`.
- "When to use it" only in `triggers` or `tool-affinity`, not the description.
- A body that restates identity, tool discovery, or platform context.

## Authoring checklist

1. It spans connectors or governs the agent.
2. The strategy fits: `always` only for short durable rules.
3. A `dynamic` description says when to use it.
4. The body is under 4,000 characters, in second person.
5. Priority is 11–99.
6. Show the user the name, the change, and any `allowed-tools`; confirm; save
   it on request; then give them any trigger or tool-affinity to add in Skills
   settings.
