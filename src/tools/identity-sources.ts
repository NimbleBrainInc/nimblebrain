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
 * Reserved wire prefix marking a **personal connector** — an MCP connection the
 * caller installed on their own identity, reached through the identity door.
 *
 * Wire tool names are bare `<source>__<tool>`, so a workspace source and a
 * personal connector of the same name would be indistinguishable to the model
 * and at dispatch. That collision is real and is NOT catchable at install time:
 * the install guard only sees the *caller's* own personal connectors, so user A
 * installing `gmail` into a shared workspace cannot know that member B holds a
 * personal `gmail` — or will install one tomorrow, or join the workspace next
 * week. Exactly one of the two doors therefore has to carry a marker.
 *
 * We mark the personal side because it is the **rare** one: a session surfaces
 * every tool of every workspace source, and only the caller's granted personal
 * connectors. Marking the common side is what the retired `ws_<id>-` prefix did,
 * and it cost 40 characters of a 64-character budget to disambiguate a case that
 * is usually empty.
 *
 * The marker also makes the credential boundary legible. `gmail__send` (the
 * workspace's shared account) versus `my_gmail__send` (the caller's own) is a
 * distinction the model must get right for a send-mail tool, and an opaque
 * workspace id never communicated it.
 *
 * **Why `my_` and not `my-`.** The marker has to live OUTSIDE the alphabet a
 * real source name can be built from, or reserving it starts rejecting
 * legitimate connectors. `slugifyServerName` emits `[a-z0-9-]` and maps every
 * other character to `-`, so a kebab marker is squarely inside its image:
 * `@my/thing` slugs to `my-thing` and `my-notes/mcp` to `my-notes-mcp`, both of
 * which a `my-` reservation refuses to install. It never emits `_`, so `my_`
 * cannot be produced by any catalog install and reserving it costs nothing.
 *
 * A single `_` inside a source segment is safe — only a DOUBLE underscore would
 * break the `__` split, and this adds one.
 */
export const PERSONAL_CONNECTOR_PREFIX = "my_";

/**
 * Whether a bare source name addresses a personal connector.
 *
 * Reserved: a **workspace** source may not take this prefix, or it would shadow
 * the identity door. Enforced at install by `isReservedServerName` /
 * `validateServerName` rather than here, so the read path stays a pure
 * predicate.
 */
export function isPersonalConnectorName(sourceName: string): boolean {
  return sourceName.startsWith(PERSONAL_CONNECTOR_PREFIX);
}

/** The connector's own `serverName`, with the reserved wire prefix removed. */
export function personalConnectorServerName(sourceName: string): string {
  return sourceName.slice(PERSONAL_CONNECTOR_PREFIX.length);
}

/** The wire form of a personal connector's source name. */
export function personalConnectorWireName(serverName: string): string {
  return `${PERSONAL_CONNECTOR_PREFIX}${serverName}`;
}

/**
 * Automations tools that stay reachable inside an unattended run: read-only
 * introspection plus `cancel`. They surface run health without persisting a new
 * instruction. Everything else in the `automations__*` namespace — the authoring
 * and run-triggering tools, and any tool added to the namespace later — is
 * barred, so the boundary fails CLOSED as the surface grows (an allowlist, not a
 * denylist).
 */
export const AUTOMATIONS_TASK_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "automations__list",
  "automations__status",
  "automations__runs",
  "automations__run_result",
  "automations__cancel",
]);

/**
 * Whether an identity tool is barred from an unattended task run (an
 * automation). An automation fires as its owner with no human present to
 * confirm, and routinely ingests untrusted content (email, web pages, tickets).
 * Reaching the automation-authoring surface from inside a run lets an injected
 * instruction rewrite the run's own prompt/schedule, spawn new automations, or
 * fire them — a foothold that outlives the run and is then scheduler-driven.
 *
 * Only the `automations__*` namespace is gated — `conversations__*` / `files__*`
 * are safe in a run. Within it, the check is an allowlist: anything not in
 * {@link AUTOMATIONS_TASK_SAFE_TOOLS} is forbidden, so a newly-added authoring
 * tool is denied by default rather than silently reopening the vector.
 *
 * The boundary is enforced ambiently: the automations source refuses these
 * tools whenever `RequestContext.unattended` is set (see
 * `createAutomationsSource`), and that flag is inherited by a delegated
 * sub-agent at any depth — not only the top-level run. Surfacing subtraction in
 * `executeTask` / the delegate default set keeps them out of the model's view;
 * this predicate is the shared policy both layers read.
 * `executor.ts::containsRecursiveTool` is a separate, narrower guard on
 * operator/bundle-authored `allowedTools`.
 */
export function isTaskForbiddenIdentityTool(name: string): boolean {
  return name.startsWith("automations__") && !AUTOMATIONS_TASK_SAFE_TOOLS.has(name);
}
