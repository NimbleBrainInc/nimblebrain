import { isInternalTool, type ToolSchema } from "../engine/types.ts";
import { DEFAULT_MAX_DIRECT_TOOLS } from "../limits.ts";
import type { Skill } from "../skills/types.ts";
import { isIdentitySource } from "./identity-sources.ts";
import { bareToolName } from "./namespace.ts";

const SYSTEM_TOOL_PREFIX = "nb__";

/**
 * A tool is a system tool if its BARE name (post-namespace-strip) starts
 * with `nb__`. Workspace tools are namespaced as `ws_<id>-nb__<tool>`, so a
 * raw `name.startsWith("nb__")` check silently classifies zero system tools —
 * which empties the Tier-2 direct list and hands the model no tools at all.
 */
function isSystemTool(t: ToolSchema): boolean {
  return bareToolName(t.name).startsWith(SYSTEM_TOOL_PREFIX);
}

/** The source segment of a tool's bare name (`files__read` → `files`). */
function toolSource(t: ToolSchema): string {
  const bare = bareToolName(t.name);
  const sep = bare.indexOf("__");
  return sep === -1 ? bare : bare.slice(0, sep);
}

/**
 * A tool is a KERNEL tool if it's the `nb__` system core OR belongs to a kernel
 * identity source (`files`/`conversations`/`automations`, per
 * {@link isIdentitySource}). Kernel tools are always surfaced DIRECT: they are
 * the substrate the model reaches for unprompted, so they belong in the stable,
 * cached tool prefix rather than being proxied and promoted on demand.
 * Promotion mutates the tools block — which precedes the messages in the
 * request — so proxying a hot kernel tool busts the conversation's cached
 * prefix on every promote. Keeping kernel tools direct keeps that prefix stable.
 */
function isKernelTool(t: ToolSchema): boolean {
  return isSystemTool(t) || isIdentitySource(toolSource(t));
}

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
 * - Tier 2 (>maxDirectTools, no skill or skill has no allowedTools): only KERNEL tools
 *   direct (nb__* system core + identity sources — files/conversations/automations), rest proxied.
 * - Tier 3 (skill matched with allowedTools): tools matching skill globs + kernel tools direct, rest proxied.
 *
 * Kernel tools stay direct because they're the substrate the model reaches for unprompted;
 * proxying them would force a promote (nb__manage_tools) on first use, and each promote mutates
 * the tools block ahead of the messages — busting the conversation's cached prefix.
 *
 * When `requestAllowedTools` is provided, it acts as a pre-filter: only tools matching those
 * patterns (plus nb__* system tools) survive before tiered surfacing runs. Identity tools are
 * NOT force-kept by that pre-filter — an explicit request-level allow-list can still exclude them.
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
  let visibleTools = allTools.filter((t) => !isInternalTool(t));

  // Pre-filter by request-level allowedTools (if provided)
  if (config.requestAllowedTools) {
    const patterns = config.requestAllowedTools;
    visibleTools = visibleTools.filter(
      (t) => isSystemTool(t) || patterns.some((p) => matchToolPattern(t.name, p)),
    );
  }

  const maxDirect = config.maxDirectTools ?? DEFAULT_MAX_DIRECT_TOOLS;
  const kernelTools = visibleTools.filter(isKernelTool);
  const allowedTools = matchedSkill?.manifest.allowedTools;

  let result: { direct: ToolSchema[]; proxied: ToolSchema[] };

  // Tier 3: skill matched with allowedTools globs
  if (allowedTools && allowedTools.length > 0) {
    const matched = visibleTools.filter(
      (t) => !isKernelTool(t) && allowedTools.some((glob) => matchToolPattern(t.name, glob)),
    );
    const directSet = new Set([...kernelTools, ...matched]);
    result = {
      direct: [...directSet],
      proxied: visibleTools.filter((t) => !directSet.has(t)),
    };
  } else if (visibleTools.length <= maxDirect) {
    // Tier 1: total tools within budget — all direct
    result = { direct: visibleTools, proxied: [] };
  } else {
    // Tier 2: too many tools, no skill filter — only kernel tools direct
    const kernelSet = new Set(kernelTools);
    result = {
      direct: kernelTools,
      proxied: visibleTools.filter((t) => !kernelSet.has(t)),
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
  // Namespaced tool names carry a `ws_<id>-` namespace prefix. Patterns
  // coming from `skill.allowedTools`
  // / `request.allowedTools` / `focusedServerName` are typically authored
  // against the BARE form (`source__tool` or `source__*`) — that's the
  // shape skill manifests and the chat composer use. Match against both
  // the full namespaced name AND the bare inner form (via the canonical
  // `bareToolName` parser, not a hand-rolled separator split) so legacy
  // patterns keep working and namespace-aware patterns also match.
  const inner = bareToolName(toolName);
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
