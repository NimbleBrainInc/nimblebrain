import type { ToolSchema } from "../engine/types.ts";
import { DEFAULT_MAX_DIRECT_TOOLS } from "../limits.ts";
import type { Skill } from "../skills/types.ts";

const SYSTEM_TOOL_PREFIX = "nb__";

/**
 * Filter tools by allowed-tools patterns from a skill.
 * Supports exact match and glob patterns (e.g., "leadgen__*").
 */
export function filterTools(tools: ToolSchema[], patterns: string[]): ToolSchema[] {
  if (patterns.length === 0) return tools;
  return tools.filter((tool) => patterns.some((pattern) => matchToolPattern(tool.name, pattern)));
}

/**
 * Tiered tool surfacing strategy (§7.2).
 *
 * - Tier 1 (≤maxDirectTools total): all tools direct, nothing proxied.
 * - Tier 2 (>maxDirectTools, no skill or skill has no allowedTools): only nb__* system tools direct, rest proxied.
 * - Tier 3 (skill matched with allowedTools): tools matching skill globs + system tools direct, rest proxied.
 *
 * When `requestAllowedTools` is provided, it acts as a pre-filter: only tools matching
 * those patterns (plus nb__* read-only tools) survive before tiered surfacing runs.
 */
export function surfaceTools(
  allTools: ToolSchema[],
  matchedSkill: Skill | null,
  config: {
    maxDirectTools?: number;
    focusedServerName?: string;
    requestAllowedTools?: string[];
  } = {},
): { direct: ToolSchema[]; proxied: ToolSchema[] } {
  // Filter out internal tools — they stay callable via bridge/API but never appear in the LLM's tool list
  let visibleTools = allTools.filter((t) => !t.annotations?.["ai.nimblebrain/internal"]);

  // Pre-filter by request-level allowedTools (if provided)
  if (config.requestAllowedTools) {
    const patterns = config.requestAllowedTools;
    visibleTools = visibleTools.filter(
      (t) =>
        t.name.startsWith(SYSTEM_TOOL_PREFIX) || patterns.some((p) => matchToolPattern(t.name, p)),
    );
  }

  const maxDirect = config.maxDirectTools ?? DEFAULT_MAX_DIRECT_TOOLS;
  const systemTools = visibleTools.filter((t) => t.name.startsWith(SYSTEM_TOOL_PREFIX));
  const allowedTools = matchedSkill?.manifest.allowedTools;

  let result: { direct: ToolSchema[]; proxied: ToolSchema[] };

  // Tier 3: skill matched with allowedTools globs
  if (allowedTools && allowedTools.length > 0) {
    const matched = visibleTools.filter(
      (t) =>
        !t.name.startsWith(SYSTEM_TOOL_PREFIX) &&
        allowedTools.some((glob) => matchToolPattern(t.name, glob)),
    );
    const directSet = new Set([...systemTools, ...matched]);
    result = {
      direct: [...directSet],
      proxied: visibleTools.filter((t) => !directSet.has(t)),
    };
  } else if (visibleTools.length <= maxDirect) {
    // Tier 1: total tools within budget — all direct
    result = { direct: visibleTools, proxied: [] };
  } else {
    // Tier 2: too many tools, no skill filter — only system tools direct
    const systemSet = new Set(systemTools);
    result = {
      direct: systemTools,
      proxied: visibleTools.filter((t) => !systemSet.has(t)),
    };
  }

  // Post-process: promote focused app's tools to direct
  if (config.focusedServerName) {
    const prefix = `${config.focusedServerName}__`;
    const promoted = result.proxied.filter((t) => t.name.startsWith(prefix));
    if (promoted.length > 0) {
      result.direct = [...result.direct, ...promoted];
      result.proxied = result.proxied.filter((t) => !t.name.startsWith(prefix));
    }
  }

  return result;
}

function matchToolPattern(toolName: string, pattern: string): boolean {
  // Stage 2 (T006): tool names from the cross-workspace aggregator carry
  // a `ws_<id>/` namespace prefix. Patterns coming from `skill.allowedTools`
  // / `request.allowedTools` / `focusedServerName` are typically authored
  // against the BARE form (`source__tool` or `source__*`) — that's the
  // shape skill manifests and the chat composer use. Match against both
  // the full namespaced name AND the post-`/` inner form so legacy
  // patterns keep working and namespace-aware patterns (`ws_<id>/...`)
  // also match precisely when intended.
  const inner = (() => {
    const slashIndex = toolName.indexOf("/");
    return slashIndex >= 0 && toolName.startsWith("ws_")
      ? toolName.slice(slashIndex + 1)
      : toolName;
  })();
  const candidates = inner === toolName ? [toolName] : [toolName, inner];
  if (!pattern.includes("*")) {
    return candidates.some((c) => c === pattern);
  }
  // Convert glob to regex: "leadgen__*" → /^leadgen__.*$/
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );
  return candidates.some((c) => regex.test(c));
}
