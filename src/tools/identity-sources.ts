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
 * v1 set: `conversations`. Files and automations join when their data moves to
 * identity ownership (each plugs into the same door — see ACCESS_MODEL).
 */
export const IDENTITY_SOURCES: ReadonlySet<string> = new Set(["conversations"]);

/** Whether a source (by name) is a kernel identity source. */
export function isIdentitySource(name: string): boolean {
  return IDENTITY_SOURCES.has(name);
}
