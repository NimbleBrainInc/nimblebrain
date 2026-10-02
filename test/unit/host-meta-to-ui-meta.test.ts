import { describe, expect, it } from "bun:test";
import { hostMetaToUiMeta } from "../../src/connectors/runtime/defaults.ts";

const PLACEMENT = {
  slot: "sidebar.apps",
  resourceUri: "ui://hello/main",
  route: "@nimblebraininc/hello",
  label: "Hello",
  icon: "hand",
};

describe("hostMetaToUiMeta", () => {
  it("maps placements from host metadata", () => {
    const ui = hostMetaToUiMeta({ host_version: "1.0", placements: [PLACEMENT] });

    expect(ui).not.toBeNull();
    expect(ui!.placements).toHaveLength(1);
    expect(ui!.placements![0].slot).toBe("sidebar.apps");
    expect(ui!.placements![0].resourceUri).toBe("ui://hello/main");
  });

  it("projects a valid placement whether or not the block sets a name", () => {
    expect(hostMetaToUiMeta({ host_version: "1.0", placements: [PLACEMENT] })).not.toBeNull();
  });

  it("does not read the deprecated name, icon or category", () => {
    const ui = hostMetaToUiMeta({
      host_version: "1.0",
      name: "Hello",
      icon: "hand",
      category: "operations",
      placements: [PLACEMENT],
    } as never);
    expect(ui).toEqual({ placements: [PLACEMENT] });
  });

  it("returns null when host metadata is missing", () => {
    expect(hostMetaToUiMeta(undefined)).toBeNull();
  });

  it("returns null when the block declares no placement", () => {
    expect(hostMetaToUiMeta({ host_version: "1.0", name: "Hello" } as never)).toBeNull();
    expect(hostMetaToUiMeta({ host_version: "1.0", placements: [] })).toBeNull();
  });

  it("returns null when no declared placement is valid", () => {
    expect(
      hostMetaToUiMeta({
        host_version: "1.0",
        placements: [{ slot: "sidebar.apps", resourceUri: "https://evil.example/x" }],
      }),
    ).toBeNull();
  });
});
