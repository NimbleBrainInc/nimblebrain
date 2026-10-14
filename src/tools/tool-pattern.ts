/**
 * The single site where a tool-name glob is matched.
 *
 * There were two — `surfacing.ts::matchToolPattern` (`skill.allowedTools`,
 * `request.allowedTools`) and `select.ts::toolMatches`
 * (`skill.toolAffinity`). They read the SAME on-disk skill manifest against the
 * SAME tool names, and drifted the moment one was taught about the retired
 * `ws_<id>-` prefix and the other was not: a skill whose `toolAffinity` used the
 * namespaced shape stopped selecting anything, so the skill never loaded and its
 * (correctly matched) `allowedTools` never got a chance to apply. Silently.
 *
 * Two matchers over one manifest is the duplication that guarantees the next
 * editor fixes one of them. Hence one function, two callers.
 *
 * ## The two normalizations, and why only one is symmetric
 *
 * **The retired `ws_<id>-` prefix is stripped from BOTH sides.** Names are bare
 * now, so a pattern authored against the prefix would match nothing — and those
 * patterns live in skill frontmatter and task records this repo cannot
 * migrate.
 *
 * **The `my_` personal-connector marker is stripped from NEITHER.** It is the
 * only thing separating the caller's own account from a same-named workspace
 * source, so collapsing it would erase the credential distinction it exists for.
 *
 * ## The asymmetry that makes normalization safe
 *
 * A *normalized* pattern may not reach a marked name. When the prefix was live,
 * personal connectors were bare and `ws_<id>-…` could only ever name workspace
 * tools — so honouring such a pattern against a marked name would GRANT
 * something its author could not have written. The sharp case is the bare
 * remainder: `ws_<id>-*` collapses to `*`, which otherwise matches every
 * connector the caller has granted, widening a scoping directive into the
 * caller's own credentials.
 *
 * A pattern authored bare is untouched: a literal `*` still matches everything,
 * deliberately, and the skill validator warns about that one on its own.
 */

import { PERSONAL_CONNECTOR_PREFIX } from "./identity-sources.ts";
import { bareToolName } from "./namespace.ts";

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

  const normalizedPattern = bareToolName(pattern);
  const normalizedName = bareToolName(toolName);

  // See the header: a pattern that CARRIED the retired prefix could not have
  // named a personal connector when it was authored, so stripping it must not
  // let it reach one now.
  if (normalizedPattern !== pattern && normalizedName.startsWith(PERSONAL_CONNECTOR_PREFIX)) {
    return false;
  }

  if (normalizedPattern === "*") return true;
  if (!normalizedPattern.includes("*")) return normalizedName === normalizedPattern;

  // Glob → anchored regex. Escape everything with meaning in a regex except the
  // `*` we are implementing, so a pattern containing e.g. `.` matches literally.
  const regex = new RegExp(
    `^${normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );
  return regex.test(normalizedName);
}

/**
 * The tools a run limited to `allowedTools` reaches whatever its list says:
 * search and activation, which are how it finds and promotes the tools it is
 * allowed. Every other `nb__` tool reads or changes something beyond those
 * tools (a connector's resources, the owner's preferences, a skill's body), so
 * it passes only when the list names it.
 */
const RUN_DISCOVERY_TOOLS: ReadonlySet<string> = new Set(["nb__search", "nb__manage_tools"]);

/** Whether a run limited to `allowedTools` may reach `toolName`. */
export function isToolAllowedForRun(toolName: string, allowedTools: string[]): boolean {
  if (RUN_DISCOVERY_TOOLS.has(bareToolName(toolName))) return true;
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
      !RUN_DISCOVERY_TOOLS.has(bareToolName(pattern)) &&
      !toolNames.some((name) => toolNameMatchesPattern(name, pattern)),
  );
}
