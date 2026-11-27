import { describe, expect, it } from "bun:test";
import { CONTRACT_SOURCE_NAMES, isIdentitySource } from "../../../src/tools/identity-sources.ts";

describe("identity sources", () => {
  it("recognizes the kernel identity sources", () => {
    for (const source of ["conversations", "files", "tasks"]) {
      expect(isIdentitySource(source)).toBe(true);
    }
    expect(isIdentitySource("nb")).toBe(false);
    expect(isIdentitySource("some-connector")).toBe(false);
  });

  it("names each contract's bound server by the kernel's own source name", () => {
    expect(CONTRACT_SOURCE_NAMES.get("ai.nimblebrain.conversations")).toBe("conversations");
    expect(CONTRACT_SOURCE_NAMES.get("ai.nimblebrain.tasks")).toBe("tasks");
    for (const name of CONTRACT_SOURCE_NAMES.values()) expect(isIdentitySource(name)).toBe(true);
  });
});
