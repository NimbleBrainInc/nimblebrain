import { isToolEnabled, isToolVisibleToRole, type ResolvedFeatures } from "../config/features.ts";
import { isInternalTool, type ToolSchema } from "../engine/types.ts";

export function isToolEligibleForPromotion(
  tool: ToolSchema,
  orgRole: string | null | undefined,
  features: ResolvedFeatures,
): boolean {
  return (
    isToolVisibleToRole(tool.name, orgRole) &&
    isToolEnabled(tool.name, features) &&
    !isInternalTool(tool)
  );
}
