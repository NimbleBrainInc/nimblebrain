import { isModelVisible, type ToolSchema } from "../engine/types.ts";
import { DEFAULT_MAX_DIRECT_TOOLS } from "../limits.ts";
import type { Skill } from "../skills/types.ts";
import { toolNameMatchesPattern } from "./tool-pattern.ts";

/**
 * Choosing a tool's surface — the three resting places.
 *
 * Two orthogonal axes govern any tool:
 *   - AUTHORITY — who may invoke it (member/admin). Enforced in the
 *     handler and by role visibility; NOT this file's concern.
 *   - DRIVER — what surface decides to call it: the agent *reasoning* about a
 *     capability, or a deterministic *UI affordance* a human clicks. This is
 *     the axis that decides where a tool lands below.
 *
 * By how the agent relates to a tool, it belongs in exactly one of:
 *   1. KERNEL-DIRECT — hot; turns call it often enough that sending it on every
 *      call costs less than finding it when needed. Full schema in the
 *      always-cached prefix. The set is named, not derived: {@link DIRECT_KERNEL_TOOLS}.
 *   2. PROXIED — the agent needs it only occasionally. Discovered via
 *      `nb__search` and promoted on demand, or surfaced by a trigger-matched
 *      skill's `allowed-tools`, so it stays OUT of the default prefix (Tier 2/3
 *      here). Once a conversation calls it, it stays direct for the rest of that
 *      conversation (`carriedTools`), so the prefix grows once and then holds.
 *   3. APP-ONLY — the agent NEVER legitimately calls it; it's a UI-driven
 *      affordance the web shell or a view invokes by name (settings/admin ops:
 *      `manage_*`, `set_model_config`, `briefing`, `skills__set_status`).
 *      Declare the MCP Apps `_meta.ui.visibility: ["app"]` — stripped from EVERY listing that reaches a
 *      model: the chat tool list (`visibleTools` at the top of `surfaceTools`
 *      below), `nb__search`, the `/mcp` `tools/list`, and the invalid-name
 *      recovery hint (`ToolRegistry.searchTools`); the engine also refuses to
 *      promote it. Only the CALL paths stay open — `/v1/workspaces/:wsId/tools/call`,
 *      `/v1/tools/call` (a tool that works with no workspace) and `/mcp` `tools/call`
 *      still dispatch by name, which is how the web shell and views
 *      reach it. A connector's tool that declares the same visibility is held to
 *      the same rule. Feature gating (`isToolEnabled`) and role visibility
 *      (`isToolVisibleToRole`) are independent filters layered on top, not
 *      substitutes for this one.
 *
 * Two rules keep this honest:
 *   - A new `nb__*`/identity tool DEFAULTS to proxied. Add it to
 *     {@link DIRECT_KERNEL_TOOLS} only when turns call it often: every direct
 *     schema rides every model call, which is how a surface accretes cost.
 *   - ONE TOOL, ONE AUDIENCE. App-only visibility is honest only when the WHOLE tool is
 *     UI-driven. A tool that straddles agent + UI use is mis-sized: split it,
 *     don't flag the aggregate.
 */
const SYSTEM_TOOL_PREFIX = "nb__";

/** A tool is a system tool if its name starts with `nb__`. */
function isSystemTool(t: ToolSchema): boolean {
  return t.name.startsWith(SYSTEM_TOOL_PREFIX);
}

/**
 * The kernel tools sent in full on every call (ADR-0066). A tool is here because
 * turns call it often, never because of who owns its data: an identity source's
 * tool (`files`/`conversations`/`tasks`) is held to the same test as an `nb__`
 * one. The task tools reach a turn through the task-authoring skill's
 * `allowed-tools` when its triggers match. Every other kernel tool is proxied.
 *
 * `nb__request_plugin` is the one held here for when it is called rather than
 * how often: the model asks in the message that reads an `nb__search` result
 * naming the plugin, and proxied it would first cost a promote, a round trip,
 * and a tools-block rewrite before the person sees the question.
 */
const DIRECT_KERNEL_TOOLS: ReadonlySet<string> = new Set([
  "nb__use_skill",
  "nb__status",
  "nb__search",
  "nb__manage_tools",
  "nb__request_plugin",
  "files__read",
  "files__create",
  "files__list",
]);

/** A tool is a KERNEL tool, surfaced DIRECT, when it is in {@link DIRECT_KERNEL_TOOLS}. */
function isKernelTool(t: ToolSchema): boolean {
  return DIRECT_KERNEL_TOOLS.has(t.name);
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
 *   direct ({@link DIRECT_KERNEL_TOOLS}), rest proxied.
 * - Tier 3 (skill matched with allowedTools): tools matching skill globs + kernel tools direct, rest proxied.
 *
 * Then `carriedTools` (the tools the conversation already called) join the direct set.
 * The run door matches a skill's triggers over the whole conversation and passes every
 * tool it has called, so a turn's direct set is never smaller than the last one's: the
 * tools block, which precedes the messages, changes only when something is added (ADR-0066).
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
    carriedTools?: readonly string[];
  } = {},
): { direct: ToolSchema[]; proxied: ToolSchema[] } {
  // Drop tools without "model" in their visibility — they stay callable via bridge/API but never appear in the LLM's tool list
  let visibleTools = allTools.filter(isModelVisible);

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

  // Post-process: a tool the conversation already called stays direct, appended
  // after the turn's own set, so the tools block only grows across turns.
  if (config.carriedTools?.length) {
    const carried = new Set(config.carriedTools);
    const kept = result.proxied.filter((t) => carried.has(t.name));
    if (kept.length > 0) {
      result.direct = [...result.direct, ...kept];
      result.proxied = result.proxied.filter((t) => !carried.has(t.name));
    }
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
  return toolNameMatchesPattern(toolName, pattern);
}
