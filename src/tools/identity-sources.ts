/**
 * Kernel identity sources — owned by the user, hosted OUTSIDE any workspace.
 *
 * An identity source is reachable only through the identity door: a bare
 * `<source>__<tool>` name routes to the caller's identity context, and the
 * source is NOT composed into any workspace registry (so a `ws_<id>-` name
 * targeting it fails closed — the source genuinely isn't there). Its UI is
 * served by the identity resource host, not the workspace-scoped one.
 *
 * This is the single authority for "is this source identity-scoped?" across
 * the runtime: `Runtime.getIdentitySource`, the workspace-registry partition,
 * the bare-emission in the tool-list aggregator, and the resource host all
 * read it. The web tier keeps a hand-mirror in `web/src/lib/identity-apps.ts`
 * (it can't import from `src/`); keep the two in lockstep.
 *
 * Set: `conversations`, `files` (Phase B), `automations` (Phase C) — all
 * identity-owned, each reached through the identity door (see ACCESS_MODEL).
 * Automations data lives at `users/{userId}/automations/`; a scheduled run
 * fires as its owner.
 */
export const IDENTITY_SOURCES: ReadonlySet<string> = new Set([
  "conversations",
  "files",
  "automations",
]);

/** Whether a source (by name) is a kernel identity source. */
export function isIdentitySource(name: string): boolean {
  return IDENTITY_SOURCES.has(name);
}

/**
 * Identity tools that an unattended task run (an automation) must NOT be able
 * to call. An automation fires as its owner with no human present to confirm,
 * and routinely ingests untrusted content (email, web pages, tickets). Binding
 * the automation-authoring surface into that run lets an injected instruction
 * rewrite the automation's own prompt/schedule, spawn new automations, or fire
 * them — a foothold that outlives the run and is then scheduler-driven. So the
 * mutating and run-triggering automations tools are subtracted from the identity
 * tool set before a task run is composed (`Runtime.executeTask`). Interactive
 * chat keeps them: an operator manages their automations with a human in the
 * loop.
 *
 * Read-only automations tools (`list`, `status`, `runs`, `run_result`) and
 * `cancel` are intentionally left bound — they surface run health without
 * persisting a new instruction. `executor.ts::containsRecursiveTool` is a
 * secondary guard on operator/bundle-authored `allowedTools`; this set is the
 * primary boundary and does not depend on how the automation was authored.
 */
export const TASK_FORBIDDEN_IDENTITY_TOOLS: ReadonlySet<string> = new Set([
  "automations__create",
  "automations__update",
  "automations__delete",
  "automations__run",
]);

/** Whether a tool (by bare name) is barred from an unattended task run. */
export function isTaskForbiddenIdentityTool(name: string): boolean {
  return TASK_FORBIDDEN_IDENTITY_TOOLS.has(name);
}
