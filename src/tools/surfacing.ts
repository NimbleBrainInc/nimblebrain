import type { ToolSchema } from "../engine/types.ts";
import { DEFAULT_MAX_DIRECT_TOOLS } from "../limits.ts";
import type { Skill } from "../skills/types.ts";
import { isIdentitySource } from "./identity-sources.ts";
import { bareToolName } from "./namespace.ts";

/**
 * Choosing a tool's surface — the three resting places.
 *
 * Two orthogonal axes govern any tool:
 *   - AUTHORITY — who may invoke it (member/admin/owner). Enforced in the
 *     handler and by role visibility; NOT this file's concern.
 *   - DRIVER — what surface decides to call it: the agent *reasoning* about a
 *     capability, or a deterministic *UI affordance* a human clicks. This is
 *     the axis that decides where a tool lands below.
 *
 * By how the agent relates to a tool, it belongs in exactly one of:
 *   1. KERNEL-DIRECT — hot; the agent reaches for it unprompted (`nb__search`,
 *      `nb__manage_tools`, `nb__status`, `nb__delegate`, the files/conversations
 *      basics). Full schema in the always-cached prefix. `isKernelTool` below.
 *   2. PROXIED — the agent needs it only occasionally. Discovered via
 *      `nb__search` and promoted on demand, so it stays OUT of the default
 *      prefix (Tier 2/3 here). Costs one prefix-bust per promote — worth it for
 *      cold tools, not for hot ones.
 *   3. INTERNAL — the agent NEVER legitimately calls it; it's a UI-driven
 *      affordance the web shell invokes by name over REST (settings/admin ops:
 *      `manage_*`, `set_model_config`, `briefing`). Annotate
 *      `ai.nimblebrain/internal` — stripped from every LLM tool list (chat AND
 *      external `/mcp`) at line ~75, still callable by name; promotion is
 *      refused in the engine.
 *
 * Two rules keep this honest:
 *   - A new `nb__*`/identity tool DEFAULTS to kernel-direct (it's a kernel tool
 *     by construction). Pick its slot deliberately — that default is how a
 *     surface accretes cost.
 *   - ONE TOOL, ONE AUDIENCE. `internal` is honest only when the WHOLE tool is
 *     UI-driven. A tool that straddles agent + UI use is mis-sized: split it,
 *     don't flag the aggregate.
 */
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
  let visibleTools = allTools.filter((t) => !t.annotations?.["ai.nimblebrain/internal"]);

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
