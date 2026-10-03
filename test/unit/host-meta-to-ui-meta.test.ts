import { describe, expect, it } from "bun:test";
import Ajv from "ajv";
import schema from "../../src/connectors/catalog/schemas/host-manifest.schema.json";
import { hostMetaToUiMeta } from "../../src/connectors/runtime/defaults.ts";

// Keys the schema no longer defines. A catalog that still carries them must
// load, and they must change nothing.
const REMOVED_KEYS = {
  name: "Hello",
  icon: "hand",
  category: "operations",
  primaryView: { resourceUri: "ui://hello/main" },
};

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

  it("does not read name, icon, category or primaryView", () => {
    const ui = hostMetaToUiMeta({
      host_version: "1.0",
      ...REMOVED_KEYS,
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

describe("the published host schema", () => {
  it("accepts a block that still carries the removed keys", () => {
    const validate = new Ajv({ strict: false }).compile(schema);
    const block = { host_version: "1.0", ...REMOVED_KEYS, placements: [PLACEMENT] };
    expect(validate(block)).toBe(true);
  });
});
