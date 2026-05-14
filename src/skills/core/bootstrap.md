---
name: capabilities
description: System tools for discovering and managing capabilities
version: 1.0.0
type: context
priority: 10
metadata:
  keywords: [install, search, tool, bundle, skill, mpak, capability, server, connect, configure, setup, reconfigure, version, status, health, conversation, history, recall, remember, discussed]
  triggers:
    - "install a"
    - "add a tool"
    - "search mpak"
    - "what tools"
    - "what can you do"
    - "what servers"
    - "find a server"
    - "configure"
    - "reconfigure"
    - "what version"
    - "version of"
    - "bundle status"
    - "is it working"
  category: system
  tags: [system, capabilities, mpak]
---

# Capability Management

## System Tools

- **nb__search** — Unified search tool. Use `scope: "tools"` to search installed tools by keyword (empty query lists everything). Use `scope: "registry"` to search the mpak registry for installable bundles.
- **nb__manage_tools** — Patch your active tool list in one call. Input: `{ add?: ["source__tool", ...], remove?: ["source__tool", ...] }`. Use `add` to promote discovered tools so they become callable on the next turn. Use `remove` to release tools you no longer need (system tools `nb__*` cannot be released). Combine `add` and `remove` in one call when switching domains.
- **nb__status** — Platform status. Default gives an overview (model, app count, skill count). Use `scope: "bundles"` for per-app health/version, `scope: "skills"` for loaded skills, `scope: "config"` for model and limit details.
- **nb__manage_app** — Install, uninstall, or configure apps:
  - `install` — Download, prompt for credentials if needed, start.
  - `uninstall` — Stop and remove.
  - `configure` — Re-prompt for credentials on an existing app.

## Tool Discovery Workflow

App tools are not in your direct tool list by default. To use one:

1. `nb__search` with `scope: "tools"` and a keyword → returns tool names.
2. `nb__manage_tools({ add: ["source__tool", ...] })` → makes the discovered tools callable on the next turn. Add as many as you'll need in a single call.
3. Call the tools.
4. When the user clearly switches domains (CRM → email, design → invoicing), patch in one call: `nb__manage_tools({ add: [new tools], remove: [old tools] })`. **Default to retain.** Do not release after every call; the goal is to keep the active list shaped for the current task, not to leave it empty between turns.

Never guess tool names. Never skip step 2 — a tool not in your active list is not callable, even after discovery.

## Credentials

All credentials are collected by the terminal — never in chat.

- During install: if the bundle needs credentials, the terminal prompts automatically.
- After success: if the result says "Credentials were configured" — the bundle is ready. Do not suggest further setup.
- To update credentials: use `manage_app("configure", "bundle-name")`.
- If a bundle fails to start: offer to reconfigure. Nothing else.
- **Never mention API keys, tokens, passwords, or connection strings in chat.**

## User Preferences

- **nb__set_preferences** — Set the user's display name, timezone, locale, or theme.
  - When the user says "my name is X", "call me X", "set my name to X" → call `set_preferences({ displayName: "X" })`.
  - When the user asks to change timezone, language, or theme → use the corresponding field.
  - This is for user-facing settings like name and formatting, not the agent's personality.

## Platform Capabilities

These built-in capabilities are always available. Their tools may not be in your direct tool list — follow the Tool Discovery Workflow above (`nb__search` → `nb__manage_tools({ add })` → call) using the indicated query.

- **Files** — List, search, read, write, tag, and delete workspace files. Use when the user asks about files, uploads, documents, or attachments. Search query: `"files"`
- **Conversations** — Search and recall past conversations. Use when the user references prior discussions — phrases like "we discussed", "remember when", "last time we talked about". Search query: `"conversations"`
- **Automations** — Create and manage scheduled, recurring tasks (cron or interval). Use when the user asks to schedule, automate, or set up something that runs on a timer. Search query: `"automations"`

## Rules

- If a bundle's tools appear in your tool list, it is working.
- **For any app tool not in your active list, run the Tool Discovery Workflow above (`nb__search` → `nb__manage_tools({ add })` → call).** Your tool list may only show system tools (`nb__*`). Never guess tool names; never call a tool you have not promoted via `nb__manage_tools`.
- All app tool names use the `source__tool` format (e.g., `synapse-crm__create_contact`). Never call a tool without this prefix.
- If you need tools from multiple apps in one request, batch them into a single `nb__manage_tools({ add: [...] })` call after searching each app.
- Do not install alternative bundles when one is already configured — reconfigure instead.
- "My name is X" → `set_preferences`.
