import { describe, expect, it } from "bun:test";
import { hostMetaToUiMeta } from "../../src/connectors/runtime/defaults.ts";

describe("hostMetaToUiMeta", () => {
  it("maps name, icon and placements from host metadata", () => {
    const ui = hostMetaToUiMeta({
      host_version: "1.0",
      name: "Hello",
      icon: "hand",
      placements: [
        {
          slot: "sidebar.apps",
          resourceUri: "ui://hello/main",
          route: "@nimblebraininc/hello",
          label: "Hello",
          icon: "hand",
        },
      ],
    });

    expect(ui).not.toBeNull();
    expect(ui!.name).toBe("Hello");
    expect(ui!.icon).toBe("hand");
    expect(ui!.placements).toHaveLength(1);
    expect(ui!.placements![0].slot).toBe("sidebar.apps");
    expect(ui!.placements![0].resourceUri).toBe("ui://hello/main");
  });

  it("returns null when host metadata is missing", () => {
    expect(hostMetaToUiMeta(undefined)).toBeNull();
  });

  it("returns null when host metadata has no name", () => {
    expect(hostMetaToUiMeta({ host_version: "1.0", icon: "box" })).toBeNull();
  });
});
