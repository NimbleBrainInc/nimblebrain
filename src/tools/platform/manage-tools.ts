import { textContent } from "../../engine/content-helpers.ts";
import type { ToolPromotionControls, ToolPromotionResult, ToolResult } from "../../engine/types.ts";
import type { InProcessTool } from "../in-process-app.ts";
import {
  ManageToolsInput,
  type ManageToolsInput as ManageToolsInputType,
} from "./schemas/manage-tools.ts";

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

export function createManageToolsToolDefs(
  toolPromotionCtx?: ToolPromotionControls,
): InProcessTool[] {
  return [
    {
      name: "manage_tools",
      description:
        "Patch your active tool list in one call. Pass `add` to promote discovered tools (after nb__search) so they become callable, and/or `remove` to release tools you no longer need. Both arrays are optional; supply at least one non-empty array. Per-item results are returned in structuredContent.",
      inputSchema: ManageToolsInput,
      handler: async (input): Promise<ToolResult> => {
        const { add = [], remove = [] } = input as unknown as ManageToolsInputType;
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
        // Removes run BEFORE adds so an atomic domain-switch
        // ({ add: [new tools], remove: [old tools] }) frees slots first
        // and the new adds slot in cleanly without triggering LRU eviction
        // of unrelated promoted tools as collateral. Do not swap the order
        // without re-deriving the eviction interaction.
        const released = remove.map((toolName) => toolPromotionCtx.removeTool(toolName));
        const promoted = add.map((toolName) => toolPromotionCtx.addTool(toolName));
        const batch: BatchResult = { promoted, released };
        return {
          content: textContent(summarize(batch)),
          structuredContent: { ...batch },
          isError: false,
        };
      },
    },
  ];
}
