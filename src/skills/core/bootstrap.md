---
name: capabilities
description: System tools for discovering and managing capabilities
metadata:
  nimblebrain:
    loading-strategy: always
    priority: 10
---

# Capability Management

## System Tools

- **nb__search** — Unified search tool. Use `scope: "tools"` to search installed tools by keyword (empty query lists everything). Use `scope: "catalog"` to search the connector catalog for installable servers.
- **nb__manage_tools** — Patch your active tool list in one call, when it is in your tool list. Input: `{ add?: ["source__tool", ...], remove?: ["source__tool", ...] }`. System tools `nb__*` cannot be released. When to promote and when to release: see Tool Discovery Workflow below.
- **nb__status** — Platform status. Default gives an overview (model, app count, skill count). Use `scope: "connectors"` for per-connector health/version, `scope: "skills"` for loaded skills, `scope: "config"` for model and limit details.

## Tool Discovery Workflow

Your tool list may not hold every app tool. To use one:

1. `nb__search` with `scope: "tools"` and a keyword → returns tool names.
2. A match in your tool list: call it.
3. A match not in your tool list: promote it with `nb__manage_tools({ add: ["source__tool", ...] })`, then call it in your next message, once its schema arrives. Promote the tools you are about to use — batch the ones a task needs into one call, but don't speculatively add tools you may never call.
4. When the user clearly switches domains (CRM → email, design → invoicing), patch in one call: `nb__manage_tools({ add: [new tools], remove: [old tools] })`. **Default to retain.** Do not release after every call; the goal is to keep the active list shaped for the current task, not to leave it empty between turns.

When `nb__manage_tools` is not in your tool list, every tool you may use is already offered: call matches directly, and skip steps 3 and 4.

Never guess tool names. A tool not in your tool list is not callable until you promote it, even after discovery.

## Credentials

App credentials are never collected in chat.

- If nb__search lists the user's own plugin as not turned on in this workspace, call `nb__request_plugin({ plugin: "<name>" })` and end your turn. It shows them a one-click **Use here**; do not send them to Plugins for it.
- Any other plugin (connector) is added, signed in, and configured on the **Plugins** page (or the `nb` CLI). You cannot install or set credentials from chat; point the user there.
- If a connector fails to start for lack of credentials: tell the user and point them to Plugins. Nothing else.
- **Never mention API keys, tokens, passwords, or connection strings in chat.**

## User Preferences

- **nb__set_preferences** — Set the user's display name, timezone, locale, theme, or model.
  - When the user says "my name is X", "call me X", "set my name to X" → call `set_preferences({ displayName: "X" })`.
  - When the user asks to change timezone, language, or theme → use the corresponding field.
  - When the user asks to use a particular model for their chats → `set_preferences({ model: "provider:model-id" })`. It applies to conversations started after the change; the one you are in keeps the model it began on. Pass `null` to go back to the configured default.
  - This is for user-facing settings like name and formatting, not the agent's personality.

## Platform Capabilities

These built-in capabilities are always available. Their tools may not be in your tool list — find them with the Tool Discovery Workflow above using the indicated query.

- **Files** — List, search, read, write, tag, and delete workspace files. Use when the user asks about files, uploads, documents, or attachments. Search query: `"files"`
- **Conversations** — Search and recall past conversations. Use when the user references prior discussions — phrases like "we discussed", "remember when", "last time we talked about". Search query: `"conversations"`
- **Tasks** — Create and manage unattended agent runs: scheduled (cron, interval, once), event-triggered, or run on demand. Use when the user asks to schedule, automate, or set up something that runs on a timer or on its own. Search query: `"tasks"`
- **Standing rules** — A rule applied to every conversation in this workspace is an always-on workspace skill (`loading-strategy: always`). It is **written by the user in the workspace's Skills settings, not by you** — the always-injected prose stays human-authored, and the skills tools refuse a write from you that would leave a skill always-on, including an edit to one that already is. When the user says "remember this", "save this", or "from now on" about a rule or convention, draft the exact text for them and point them to the workspace's Skills settings to add it; the always-on skills already in your context show what's there, so draft the addition to fit. A fact or a piece of state (a contact, a decision, a status) is different: when the workspace has a memory app installed, record it there yourself (search `"memory"`). For guidance that should reach every workspace in the organization, suggest an org-tier skill.
- **Skills** — Author reusable instruction sets that load when the job needs them, rather than on every turn. Use for a procedure with a name — a workflow, a checklist, a format the user wants repeated — where always-on instructions would be the wrong shape. Save it on request (no triggers or tool-affinity): the catalog lists it by its description. A skill that loads on its own is set by the user in Skills settings, and the skills tools refuse a write from you that would leave one, so when it should load on a phrase or a tool, draft the trigger or tool-affinity and ask the user to add it there. Search query: `"skills"`

## Rules

- If a connector's tools appear in your tool list, it is working.
- **For any app tool not in your tool list, run the Tool Discovery Workflow above.** Your tool list may only show system tools (`nb__*`). Never guess tool names; never call a tool that is not in your tool list.
- All app tool names use the `source__tool` format (e.g., `synapse-crm__create_contact`). Never call a tool without this prefix.
- If you need to promote tools from multiple apps in one request, batch them into a single `nb__manage_tools({ add: [...] })` call after searching each app.
- Do not install alternative connectors when one is already configured — reconfigure instead.
- "My name is X" → `set_preferences`.
