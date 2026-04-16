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
- **nb__status** — Platform status. Default gives an overview (model, app count, skill count). Use `scope: "bundles"` for per-app health/version, `scope: "skills"` for loaded skills, `scope: "config"` for model and limit details.
- **nb__manage_app** — Install, uninstall, or configure apps:
  - `install` — Download, prompt for credentials if needed, start.
  - `uninstall` — Stop and remove.
  - `configure` — Re-prompt for credentials on an existing app.

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

These built-in capabilities are always available. Their tools may not be in your direct tool list — use `nb__search` with `scope: "tools"` and the indicated query to discover them before calling.

- **Files** — List, search, read, write, tag, and delete workspace files. Use when the user asks about files, uploads, documents, or attachments. Search query: `"files"`
- **Conversations** — Search and recall past conversations. Use when the user references prior discussions — phrases like "we discussed", "remember when", "last time we talked about". Search query: `"conversations"`
- **Automations** — Create and manage scheduled, recurring tasks (cron or interval). Use when the user asks to schedule, automate, or set up something that runs on a timer. Search query: `"automations"`

## Rules

- If a bundle's tools appear in your tool list, it is working.
- **Always call `nb__search` with `scope: "tools"` before attempting any app tool call.** Your tool list may only show system tools (nb__*). App tools must be discovered first. Never guess tool names.
- All app tool names use the `source__tool` format (e.g., `synapse-crm__create_contact`). Never call a tool without this prefix.
- If you need tools from multiple apps in one request, call `nb__search` with `scope: "tools"` once per app to discover their tools, then call the discovered tools.
- Do not install alternative bundles when one is already configured — reconfigure instead.
- "My name is X" → `set_preferences`.
