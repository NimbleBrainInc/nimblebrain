import { textContent } from "../../engine/content-helpers.ts";
import type { ToolPromotionControls, ToolPromotionResult, ToolResult } from "../../engine/types.ts";
import type { InProcessTool } from "../in-process-app.ts";
import {
  ReleaseToolInput,
  type ReleaseToolInput as ReleaseToolInputType,
  UseToolInput,
  type UseToolInput as UseToolInputType,
} from "./schemas/use-release.ts";

function resultFromMutation(result: ToolPromotionResult): ToolResult {
  return {
    content: textContent(result.message),
    structuredContent: { ...result },
    isError: !result.ok,
  };
}

function noActiveRunResult(tool_name: string, action: "use" | "release"): ToolResult {
  return {
    content: textContent(`nb__${action} can only be called during an active agent run.`),
    structuredContent: {
      ok: false,
      toolName: tool_name,
      changed: false,
      reason: "no_active_run",
    },
    isError: true,
  };
}

export function createUseReleaseToolDefs(
  toolPromotionCtx?: ToolPromotionControls,
): InProcessTool[] {
  return [
    {
      name: "use",
      description:
        "Add a discovered tool to the active tool list for the rest of this run. Use after nb__search returns a tool name you need to call.",
      inputSchema: UseToolInput,
      handler: async (input): Promise<ToolResult> => {
        const { tool_name } = input as unknown as UseToolInputType;
        if (!toolPromotionCtx) return noActiveRunResult(tool_name, "use");
        return resultFromMutation(toolPromotionCtx.addTool(tool_name));
      },
    },
    {
      name: "release",
      description:
        "Remove a non-system tool from the active tool list when it is no longer needed. System tools named nb__* cannot be released.",
      inputSchema: ReleaseToolInput,
      handler: async (input): Promise<ToolResult> => {
        const { tool_name } = input as unknown as ReleaseToolInputType;
        if (!toolPromotionCtx) return noActiveRunResult(tool_name, "release");
        return resultFromMutation(toolPromotionCtx.removeTool(tool_name));
      },
    },
  ];
}
