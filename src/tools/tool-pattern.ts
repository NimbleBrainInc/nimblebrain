/**
 * The single site where a tool-name glob is matched.
 *
 * `skill.allowedTools`, `request.allowedTools` (`surfacing.ts`) and
 * `skill.toolAffinity` (`select.ts`) read the same on-disk skill manifest
 * against the same tool names, so they share one matcher: two matchers over one
 * manifest drift, and the drift silently stops a skill from loading.
 *
 * The `my_` personal-connector marker is part of the name and is matched
 * literally. It is the only thing separating the caller's own account from a
 * same-named workspace source, so `gmail__*` does not reach `my_gmail__send`.
 */

/**
 * Whether `toolName` matches `pattern`.
 *
 * Supports `*` (everything), a `<source>__*` prefix glob, a `*__<suffix>` suffix
 * glob, embedded `*`, and exact match. Anything else falls through to exact
 * match, so an unsupported shape selects only its literal self rather than
 * silently widening.
 */
export function toolNameMatchesPattern(toolName: string, pattern: string): boolean {
  if (pattern === "") return false;

  if (pattern === "*") return true;
  if (!pattern.includes("*")) return toolName === pattern;

  // Glob → anchored regex. Escape everything with meaning in a regex except the
  // `*` we are implementing, so a pattern containing e.g. `.` matches literally.
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );
  return regex.test(toolName);
}

/**
 * The tools a run limited to `allowedTools` reaches whatever its list says:
 * search and activation, which are how it finds and promotes the tools it is
 * allowed, and the skill catalog's loader, which only reads guidance the
 * workspace already offers every run. Every other `nb__` tool reads or changes
 * something beyond those (a connector's resources, the owner's preferences), so
 * it passes only when the list names it.
 */
const RUN_DISCOVERY_TOOLS: ReadonlySet<string> = new Set([
  "nb__search",
  "nb__manage_tools",
  "nb__use_skill",
]);

/** Whether a run limited to `allowedTools` may reach `toolName`. */
export function isToolAllowedForRun(toolName: string, allowedTools: string[]): boolean {
  if (RUN_DISCOVERY_TOOLS.has(toolName)) return true;
  return allowedTools.some((pattern) => toolNameMatchesPattern(toolName, pattern));
}

/**
 * The `allowedTools` entries that match none of `toolNames`, in list order. An
 * entry naming a discovery tool always matches, since a run reaches those
 * whatever its list says.
 */
export function unmatchedAllowedTools(
  allowedTools: readonly string[],
  toolNames: readonly string[],
): string[] {
  return allowedTools.filter(
    (pattern) =>
      !RUN_DISCOVERY_TOOLS.has(pattern) &&
      !toolNames.some((name) => toolNameMatchesPattern(name, pattern)),
  );
}
