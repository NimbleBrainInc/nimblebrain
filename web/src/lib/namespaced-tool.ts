// ---------------------------------------------------------------------------
// Wire tool names — web-side helpers.
//
// A wire name is `<source>__<tool>`: bare on every door, with no workspace
// prefix (a session reaches exactly one workspace, which it takes from the
// session itself). Web cannot import from `src/`, so the two questions the
// shell asks of a wire name are answered here.
// ---------------------------------------------------------------------------

import { PERSONAL_CONNECTOR_PREFIX } from "../_generated/personal-connector-prefix.ts";

/**
 * Whether an app/source name is a personal connector's marked wire name.
 *
 * Mirrors `isPersonalConnectorName` in `src/tools/identity-sources.ts`. Callers
 * that would RESOLVE the name against an app surface use this to bail: a
 * personal connector has no such surface, and the same bare name may well
 * belong to a workspace app that does.
 */
export function isPersonalConnectorAppName(name: string): boolean {
  return name.startsWith(PERSONAL_CONNECTOR_PREFIX);
}

/**
 * Extract the **source/app name** from a wire tool name: everything before
 * `__`. Returns `undefined` when there's no `__` (not an app-owned call).
 *
 * The REST surfaces that own a resource — `POST /v1/workspaces/:wsId/resources/read`,
 * `GET /v1/workspaces/:wsId/apps/:name/resources/*` — key the workspace
 * registry by this name (`synapse-collateral`).
 *
 * **The personal-connector marker is KEPT.** Every consumer of this value
 * re-resolves it — `getResources(appName, …)`, `readResource(appName, …)`,
 * `openArtifact({ appName, … })` — and none renders it as text, so it is an
 * identity, not a label. De-marking it would hand those callers `gmail` for a
 * `my_gmail__send` call, and `GET /v1/workspaces/:wsId/apps/gmail/resources/*` resolves through
 * the WORKSPACE registry: a same-named workspace app would serve its UI, mount
 * in the transcript, and its bridge would then dispatch bare `gmail__*` — the
 * workspace source, on the workspace's credentials, for a call the user made
 * against their own account. Strip the marker only where a human reads the
 * string.
 */
export function appNameFromToolName(wireName: string): string | undefined {
  const sep = wireName.indexOf("__");
  return sep > 0 ? wireName.slice(0, sep) : undefined;
}
