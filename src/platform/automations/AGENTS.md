# Automations

Scope: the automations platform app (`src/platform/automations/`). Tool-authoring rules for every platform app are in `src/platform/AGENTS.md`.

## Automations are workspace-owned

An automation lives at `workspaces/<wsId>/automations/<ownerId>/<automationId>.json`, one file per automation. Construct paths ONLY via `src/platform/automations/paths.ts` (`workspaceAutomationsDir` and friends); `check:automation-paths` rejects the identity-scoped `getIdentityContext(...).getDataPath("automations")` and hand-built `users/<id>/automations/` paths.

- **The workspace comes from `RequestContext.workspaceId`.** Like files, `automations__*` is an identity-door tool, so it reads the same single bound workspace every other kernel source does.
- **A scheduled run fires as its owner.** The scheduler scans `workspaces/*/automations/*/` and keys by `${wsId}/${ownerId}/${id}`. The run is an identity-bound session **walled to** the automation's provenance `workspaceId` — its tools plus the owner's identity tools, with NO cross-workspace reach.
- **Membership is re-checked per run.** It is stamped from the creator's trusted context at create, and the run-start door (`Runtime.startRun`) then denies any run whose owner is no longer a member of the provenance workspace (`WorkspaceMembershipRevokedError`, thrown before the opening message is written and before any tool binding). It is the same gate, at the same call site, that refuses a conversation resume — only the refusal differs, because the callers' contracts do. The scheduler classifies that denial as **skipped**, not failed: no `consecutiveErrors` bump, no auto-disable. So a removed owner's automation stops acting immediately and **self-heals** if they are re-added. Personal workspaces are sole-member, so they never gate.
- **A run produces a run result, not a conversation.** Each run leaves a deliverable (final output), an activity log, and refs to any files it wrote (in the workspace file store) under `…/automations/<ownerId>/runs/<automationId>/` — an append-only `index.jsonl` of `AutomationRun` summaries plus a per-run `<runId>.result.json`. `runtime.executeTask` returns a `runId` and the deliverable, and creates no conversation.
