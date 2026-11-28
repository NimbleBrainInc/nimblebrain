import { describe, expect, test } from "bun:test";
import type { Plugin } from "../_generated/platform-schemas/plugins";
import { catalogLine } from "../lib/plugins";

function plugin(over: Partial<Plugin> = {}): Plugin {
  return {
    id: "workspace:plugin:notion@acme",
    displayName: "Notion",
    owner: { kind: "workspace" },
    granted: true,
    servers: [],
    skills: [],
    apps: [],
    ...over,
  };
}

describe("catalogLine", () => {
  test("a required plugin says it cannot be removed here", () => {
    expect(catalogLine(plugin({ required: true }))).toContain("cannot be removed");
  });

  test("a plugin its catalog no longer offers says it stays installed", () => {
    expect(catalogLine(plugin({ noLongerOffered: true }))).toContain("No longer offered");
  });

  test("an ordinary plugin has no line", () => {
    expect(catalogLine(plugin())).toBeNull();
  });
});
