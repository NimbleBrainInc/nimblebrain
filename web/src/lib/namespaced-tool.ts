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
 * Mirrors `isPersonalConnectorName` in `src/tools/identity-sources.ts`. The
 * marked name resolves on the server to the caller's own granted connection;
 * the bare name may belong to a workspace app, so never strip the marker from a
 * name that will be resolved (see `appNameFromToolName`).
 */
export function isPersonalConnectorAppName(name: string): boolean {
  return name.startsWith(PERSONAL_CONNECTOR_PREFIX);
}

/**
 * A personal connector's own `serverName`, from its marked wire source
 * (`my_gmail` → `gmail`). Mirrors `personalConnectorServerName` in
 * `src/tools/identity-sources.ts`. Only for matching against a listing that
 * names the connector by its server name; never re-resolve the result against
 * an app surface (see `appNameFromToolName`).
 */
export function personalConnectorServerName(source: string): string {
  return source.slice(PERSONAL_CONNECTOR_PREFIX.length);
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
 * `openArtifact({ appName, … })`, and the bridge's `/mcp` calls — and none
 * renders it as text, so it is an identity, not a label. The marked name
 * resolves to the caller's own granted connection; de-marking it would hand
 * those callers `gmail` for a `my_gmail__send` call, which resolves through the
 * WORKSPACE registry: a same-named workspace app would serve its UI, and its
 * bridge would dispatch bare `gmail__*` on the workspace's credentials for a
 * call the user made against their own account. Strip the marker only where a
 * human reads the string.
 */
export function appNameFromToolName(wireName: string): string | undefined {
  const sep = wireName.indexOf("__");
  return sep > 0 ? wireName.slice(0, sep) : undefined;
}
