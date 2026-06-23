---
name: skill-authoring
description: Teaches the agent how to create well-structured user skills. Use when creating, modifying, customizing, deleting, or managing a skill, behavior, trigger, priority, or allowed-tools.
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 50
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

# Skill Authoring Guide

When the user asks you to create, modify, or manage behavioral
customizations, use the `nb__skills` tool surface:

- `skills__create` — write a new skill at org/workspace/user scope
- `skills__update` — patch manifest fields and/or replace the body
- `skills__delete` — remove a skill (snapshots to `_versions/` first)
- `skills__activate` / `skills__deactivate` — flip status without deleting
- `skills__list` / `skills__read` — inspect what exists before changing anything

Always `skills__list` before mutating so you know what you're working with.
Follow the guidelines below.

## Choosing how it loads — `loading-strategy`

- **`always`** (in context every turn): for global rules that apply to every
  message — language preference, response format, tone. Keep it short.
  Priority 11–30 for high-authority rules, 50–80 for soft preferences.
- **`dynamic`** (loaded only when relevant): for domain behavior — compliance
  review, research mode, code review. A dynamic skill activates from its
  **description** (the model picks it out of the catalog), and optionally via
  `tool-affinity` (when specific tools are active) or `triggers` (an exact
  phrase).

## Write the description to be found

A dynamic skill is activated mainly by its **description** — the model reads
it in the catalog and decides whether to pull the skill in. So the
description must state **what the skill does and when to use it**, including
the words a user would actually say (e.g. "Extract text from PDFs, fill
forms, merge files. Use when the user mentions PDFs, forms, or document
extraction."). A thin description means the skill is never reached for.

## Triggers (optional — for must-fire)

`triggers` are exact substring phrases for deterministic activation: when a
skill MUST load and you can't rely on the model noticing the catalog (e.g. a
compliance rule). Good triggers are:
- Specific enough to avoid false positives: "compliance review", not "review"
- Natural phrases users actually type
- 2–4 per skill

## Writing the body

- Instructions TO the agent, not descriptions about it
- Imperative voice: "Always cite section numbers", not "The agent should cite"
- Specific about format: "Use bullet points with bold headers"
- Compose: don't restate identity (soul) or tool discovery (bootstrap)
- Stay under ~500 words — the body competes for context window space

## Tools the skill calls — `allowed-tools`

To scope a skill to specific tools, set `allowed-tools` (a space-separated
list of tools it may call, e.g. `policy_search__find`). This is distinct from
`tool-affinity`, which decides *when the skill loads*. Before creating,
`nb__search` with scope `tools` to confirm the tools exist; if they're
missing, tell the user to install the providing app from the Apps section of
settings.

## Choosing the scope

Each `skills__create` writes to one tier — pick by reach:

- **org** — every conversation in every workspace. Org-wide voice / policy. Org admin only.
- **workspace** — the active workspace only. Default for domain workflows. Workspace admin.
- **user** — your own conversations only. Personal preferences. Self-write only.

## Priority guidelines

- 0–10: RESERVED for core skills. Never use.
- 11–20: High-authority (language, accessibility)
- 21–40: Medium (formatting, tone)
- 41–60: Standard (default 50)
- 61–99: Low-priority / fallback

## What skills cannot do

- Change runtime config (maxIterations, model) — that's `nimblebrain.json`.
- Create tools — that needs an MCP server bundle.
- Override core identity (soul) — they layer on top.

## Confirming with the user

Before creating or editing a skill, show:
1. The skill name and how it loads (`always`, or `dynamic` + any triggers / tool-affinity)
2. A summary of the behavioral change
3. Any tool scoping (`allowed-tools`)
4. Ask for confirmation

After creation, suggest a test phrase (for a trigger) or note how it will be picked up.
