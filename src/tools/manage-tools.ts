import { textContent } from "../engine/content-helpers.ts";
import type { ToolPromotionControls, ToolPromotionResult, ToolResult } from "../engine/types.ts";
import { ManageToolsInput } from "../platform/schemas/manage-tools.ts";
import { type InProcessTool, typedTool } from "./in-process-app.ts";

interface BatchResult {
  promoted: ToolPromotionResult[];
  released: ToolPromotionResult[];
}

function summarize({ promoted, released }: BatchResult): string {
  const lines: string[] = [];
  if (promoted.length) {
    const ok = promoted.filter((r) => r.ok).length;
    lines.push(`Promoted ${ok}/${promoted.length}.`);
  }
  if (released.length) {
    const ok = released.filter((r) => r.ok).length;
    lines.push(`Released ${ok}/${released.length}.`);
  }
  const failures = [
    ...promoted.filter((r) => !r.ok).map((r) => `add ${r.toolName}: ${r.message}`),
    ...released.filter((r) => !r.ok).map((r) => `remove ${r.toolName}: ${r.message}`),
  ];
  if (failures.length) {
    lines.push("Failures:");
    for (const f of failures) lines.push(`  - ${f}`);
  }
  return lines.join("\n");
}

/**
 * What to say instead of "not found" for a name that is one of the caller's own
 * plugins turned off here, or null to keep the generic answer
 * (`ungrantedPluginGuidance`, `src/tools/plugin-request.ts`).
 */
export type PluginGuidanceFn = (toolName: string) => Promise<string | null>;

/** Each `not_found` add that names the caller's plugin off here, told how to ask for it. */
async function explainMissing(
  promoted: ToolPromotionResult[],
  guidanceFor: PluginGuidanceFn | undefined,
): Promise<ToolPromotionResult[]> {
  if (!guidanceFor) return promoted;
  return Promise.all(
    promoted.map(async (r) => {
      if (r.ok || r.reason !== "not_found") return r;
      const guidance = await guidanceFor(r.toolName);
      return guidance ? { ...r, message: guidance } : r;
    }),
  );
}

export function createManageToolsToolDefs(
  toolPromotionCtx?: ToolPromotionControls,
  pluginGuidance?: PluginGuidanceFn,
): InProcessTool[] {
  return [
    typedTool({
      name: "manage_tools",
      description:
        "Patch your active tool list in one call. Pass `add` to promote discovered tools (after nb__search) so they become callable, and/or `remove` to release tools you no longer need. Both arrays are optional; supply at least one non-empty array. Per-item results are returned in structuredContent.\n\nA promoted tool's schema reaches you on your next message, so call it there, not in the message that promotes it: arguments written before you see the schema are guesses.\n\nBatch every tool the task needs into one `add` — but promote only tools you actually intend to call. A promoted tool's schema is re-sent on the turns that follow, so carrying a plausible-looking extra from the search results costs tokens and buys nothing. When search returns several candidates for one job, promote the one that fits rather than all of them.",
      inputSchema: ManageToolsInput,
      handler: async (input): Promise<ToolResult> => {
        const { add = [], remove = [] } = input;
        if (add.length === 0 && remove.length === 0) {
          return {
            content: textContent(
              "nb__manage_tools requires at least one of `add` or `remove` to be non-empty.",
            ),
            structuredContent: { promoted: [], released: [], reason: "empty_input" },
            isError: true,
          };
        }
        if (!toolPromotionCtx) {
          return {
            content: textContent("nb__manage_tools can only be called during an active agent run."),
            structuredContent: { promoted: [], released: [], reason: "no_active_run" },
            isError: true,
          };
        }
        // Removes run BEFORE adds, so a swap at the promotion cap
        // ({ add: [new tools], remove: [old tools] }) frees its slots
        // before the adds are counted against it.
        const released = remove.map((toolName) => toolPromotionCtx.removeTool(toolName));
        // Sequential, not Promise.all: once the cap is reached the rest are
        // refused, so the adds must land in the order the model listed them.
        const added: ToolPromotionResult[] = [];
        for (const toolName of add) added.push(await toolPromotionCtx.addTool(toolName));
        const promoted = await explainMissing(added, pluginGuidance);
        const batch: BatchResult = { promoted, released };
        return {
          content: textContent(summarize(batch)),
          structuredContent: { ...batch },
          isError: false,
        };
      },
    }),
  ];
}
