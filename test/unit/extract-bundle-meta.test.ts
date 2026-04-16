import { describe, expect, it } from "bun:test";
import { extractBundleMeta } from "../../src/bundles/defaults.ts";

describe("extractBundleMeta", () => {
  it("extracts UI placements from host metadata", () => {
    const manifest = {
      name: "@nimblebraininc/synapse-hello",
      version: "0.1.0",
      description: "Hello World Synapse App",
      _meta: {
        "ai.nimblebrain/host": {
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
        },
      },
    };

    const meta = extractBundleMeta(manifest);

    expect(meta.manifestName).toBe("@nimblebraininc/synapse-hello");
    expect(meta.version).toBe("0.1.0");
    expect(meta.description).toBe("Hello World Synapse App");
    expect(meta.type).toBe("plain");
    expect(meta.ui).not.toBeNull();
    expect(meta.ui!.name).toBe("Hello");
    expect(meta.ui!.icon).toBe("hand");
    expect(meta.ui!.placements).toHaveLength(1);
    expect(meta.ui!.placements![0].slot).toBe("sidebar.apps");
    expect(meta.ui!.placements![0].resourceUri).toBe("ui://hello/main");
  });

  it("returns null UI when host metadata is missing", () => {
    const manifest = {
      name: "@nimblebraininc/echo",
      version: "0.1.5",
      description: "Echo server",
    };

    const meta = extractBundleMeta(manifest);

    expect(meta.ui).toBeNull();
    expect(meta.briefing).toBeNull();
    expect(meta.type).toBe("plain");
  });

  it("returns null UI when host metadata has no name", () => {
    const manifest = {
      name: "@nimblebraininc/broken",
      version: "1.0.0",
      _meta: {
        "ai.nimblebrain/host": {
          host_version: "1.0",
          icon: "box",
        },
      },
    };

    const meta = extractBundleMeta(manifest);

    expect(meta.ui).toBeNull();
  });

  it("detects upjack type from manifest metadata", () => {
    const manifest = {
      name: "@nimblebraininc/synapse-crm",
      version: "0.2.0",
      _meta: {
        "ai.nimblebrain/host": {
          host_version: "1.0",
          name: "CRM",
          icon: "users",
          placements: [
            { slot: "sidebar.apps", resourceUri: "ui://crm/main", label: "CRM" },
          ],
        },
        "ai.nimblebrain/upjack": {
          upjack_version: "0.1",
          namespace: "apps/crm",
          entities: [],
        },
      },
    };

    const meta = extractBundleMeta(manifest);

    expect(meta.type).toBe("upjack");
    expect(meta.ui).not.toBeNull();
    expect(meta.ui!.name).toBe("CRM");
    expect(meta.upjackNamespace).toBe("apps/crm");
  });

  it("returns undefined upjackNamespace for plain bundles", () => {
    const manifest = {
      name: "@nimblebraininc/echo",
      version: "0.1.5",
      description: "Echo server",
    };

    const meta = extractBundleMeta(manifest);

    expect(meta.upjackNamespace).toBeUndefined();
  });

  it("extracts briefing from host metadata", () => {
    const manifest = {
      name: "@nimblebraininc/tasks",
      version: "1.0.0",
      _meta: {
        "ai.nimblebrain/host": {
          host_version: "1.0",
          name: "Tasks",
          briefing: {
            priority: "high",
            facets: [
              { name: "overdue", label: "Overdue tasks", type: "attention" },
            ],
          },
        },
      },
    };

    const meta = extractBundleMeta(manifest);

    expect(meta.briefing).not.toBeNull();
    expect(meta.briefing!.facets).toHaveLength(1);
  });

  it("defaults version to 'unknown' when missing", () => {
    const manifest = { name: "@test/no-version" };

    const meta = extractBundleMeta(manifest);

    expect(meta.version).toBe("unknown");
  });
});
