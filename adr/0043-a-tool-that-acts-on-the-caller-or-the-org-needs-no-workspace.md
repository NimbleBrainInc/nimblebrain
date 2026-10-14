# 0043. A tool that acts on the caller or the org needs no workspace

- Status: Accepted
- Date: 2026-10-03
- Serves: secure RBAC

## Context

A workspace is the boundary for a workspace's data: its connectors, files,
conversations, skills and inbox. Some kernel tools act on none of that. They act
on the caller (`set_preferences`, `get_config`, the caller's personal
connectors) or on the org (`manage_workspaces`, `manage_users`,
`set_model_config`, the org usage report, org skills). Their handlers read no
workspace.

Every REST tool call is workspace-scoped (`/v1/workspaces/<wsId>/tools/call`,
ADR-0037), so the web shell's org and profile settings, which are in no
workspace, can reach these tools only through a workspace of their own choosing.
The workspace then contributes nothing except a membership check against a
workspace the call does not act on, and it can change the answer: the skills
listing merges the request's workspace tier, so a workspace skill hides an org
skill of the same name on the org settings page.

## Decision

- **A kernel tool that acts on the caller or the org declares that it works
  with no workspace**, in its own `_meta` (`"ai.nimblebrain/workspace":
  "optional"`, `src/tools/workspace-optional.ts`). A tool with both kinds of
  action declares it and refuses, in its handler, each action that needs a
  workspace when the request names none.
- **`POST /v1/tools/call` calls a declared kernel tool with no workspace.** It
  is identity-scoped (ADR-0037): it resolves only kernel sources, never a
  connector or an identity source, and calls only tools that declare the mark.
  Every other tool is not found there. The request context carries the caller
  and no workspace, so a handler that needs one refuses. Feature and role gates
  are the workspace door's own.
- **The same tools stay on every workspace door.** A workspace in the request
  goes unread by them. A session at `/mcp/<wsId>` and the chat agent reach them
  as before, subject to their visibility.
- **Who may call a tool is its visibility, not this mark.** A tool the agent
  never calls is app-only (`ui.visibility: ["app"]`): absent from every model
  listing, and refused at `/mcp` to any caller that is not an app view
  (`assertAgentMayCall`), which an external client's credential never is
  (ADR-0038). The org administration tools are app-only, so they are the web
  shell's and no agent's.

## Consequences

- The org and profile settings call their tools with no workspace, and their
  answers do not depend on one. The skills listing with no workspace merges the
  org and user tiers only.
- A tool's scope is readable from its definition. The mark is read only from
  kernel sources, so a connector cannot opt its tools into a route that skips
  workspace membership.
- A new kernel tool is workspace-scoped unless it declares otherwise, and
  declaring it means its handler refuses each workspace action with no
  workspace rather than reading a `null`.

## Alternatives considered

- **Move the tools into new identity sources (`account__*`, `org__*`)** —
  rejected: the tool names are a contract in operator feature flags, the
  config schema, the docs, the agent's core skill and external clients, and
  renaming them adds sources without adding a capability.
- **Keep calling them through a workspace the shell picks** — rejected: a
  workspace the call does not act on, chosen by the client, which is the
  default ADR-0036 and ADR-0037 refuse elsewhere.
- **Infer the scope from whether the handler throws without a workspace** —
  rejected: a handler that reads a `null` workspace as "all" would pass, and
  the scope would be visible nowhere.
