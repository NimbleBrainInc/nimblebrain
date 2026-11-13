import { describe, expect, it } from "bun:test";
import { extractText } from "../../../src/engine/content-helpers.ts";
import type { ToolPromotionControls, ToolPromotionResult } from "../../../src/engine/types.ts";
import { createManageToolsToolDefs } from "../../../src/tools/manage-tools.ts";

describe("nb__manage_tools", () => {
  it("test_manage_tools_cap_reached_renders_as_a_failure", async () => {
    const capReached: ToolPromotionResult = {
      ok: false,
      toolName: "app__c",
      changed: false,
      reason: "cap_reached",
      message: "app__c was not added: 2 promoted tools is the limit for this run.",
    };
    const controls: ToolPromotionControls = {
      addTool: async (toolName) =>
        toolName === "app__c"
          ? capReached
          : { ok: true, toolName, changed: true, message: `${toolName} added.` },
      removeTool: (toolName) => ({ ok: true, toolName, changed: true, message: "released" }),
    };
    const [tool] = createManageToolsToolDefs(controls);

    const result = await tool!.handler({ add: ["app__a", "app__b", "app__c"] });

    const text = extractText(result.content);
    expect(text).toContain("Promoted 2/3.");
    expect(text).toContain(`add app__c: ${capReached.message}`);
    expect(result.structuredContent).toMatchObject({
      promoted: [{ ok: true }, { ok: true }, { reason: "cap_reached" }],
    });
  });
});
