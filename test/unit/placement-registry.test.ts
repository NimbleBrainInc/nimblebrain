import { describe, test, expect } from "bun:test";
import { PlacementRegistry } from "../../src/runtime/placement-registry.ts";

describe("PlacementRegistry", () => {
  test("register adds entries and forSlot returns them sorted by priority", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [
      { slot: "sidebar.apps", resourceUri: "ui://core/app-nav", priority: 20 },
      { slot: "sidebar.conversations", resourceUri: "ui://core/conversations", priority: 10 },
      { slot: "toolbar.right", resourceUri: "ui://core/model-selector", priority: 50 },
    ]);

    const sidebar = reg.forSlot("sidebar");
    expect(sidebar).toHaveLength(2);
    expect(sidebar[0].resourceUri).toBe("ui://core/conversations");
    expect(sidebar[1].resourceUri).toBe("ui://core/app-nav");
  });

  test("forSlot with exact slot returns only that slot", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [
      { slot: "sidebar.apps", resourceUri: "ui://core/app-nav" },
      { slot: "sidebar.conversations", resourceUri: "ui://core/conversations" },
    ]);

    const apps = reg.forSlot("sidebar.apps");
    expect(apps).toHaveLength(1);
    expect(apps[0].resourceUri).toBe("ui://core/app-nav");
  });

  test("unregister removes all entries for a server", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [
      { slot: "sidebar.apps", resourceUri: "ui://core/app-nav" },
    ]);
    reg.register("tasks", [
      { slot: "main", resourceUri: "ui://tasks/board", route: "tasks" },
    ]);

    expect(reg.all()).toHaveLength(2);
    reg.unregister("tasks");
    expect(reg.all()).toHaveLength(1);
    expect(reg.all()[0].serverName).toBe("nb");
  });

  test("all returns entries grouped by slot then priority", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [
      { slot: "toolbar.right", resourceUri: "ui://core/model", priority: 50 },
      { slot: "sidebar.apps", resourceUri: "ui://core/apps", priority: 20 },
    ]);
    reg.register("tasks", [
      { slot: "sidebar.apps", resourceUri: "ui://tasks/nav", priority: 30 },
    ]);

    const all = reg.all();
    expect(all).toHaveLength(3);
    // sidebar.apps comes before toolbar.right (alphabetical)
    expect(all[0].slot).toBe("sidebar.apps");
    expect(all[0].priority).toBe(20);
    expect(all[1].slot).toBe("sidebar.apps");
    expect(all[1].priority).toBe(30);
    expect(all[2].slot).toBe("toolbar.right");
  });

  test("duplicate register replaces existing entries", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [
      { slot: "sidebar.apps", resourceUri: "ui://core/v1" },
    ]);
    reg.register("nb", [
      { slot: "sidebar.apps", resourceUri: "ui://core/v2" },
    ]);

    const all = reg.all();
    expect(all).toHaveLength(1);
    expect(all[0].resourceUri).toBe("ui://core/v2");
  });

  test("default priority is 100", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [
      { slot: "main", resourceUri: "ui://core/page" },
    ]);

    expect(reg.all()[0].priority).toBe(100);
  });

  test("register with wsId sets wsId on all entries", () => {
    const reg = new PlacementRegistry();
    reg.register("echo", [
      { slot: "sidebar.apps", resourceUri: "ui://echo/nav" },
      { slot: "main", resourceUri: "ui://echo/page" },
    ], "ws-eng");

    const all = reg.all();
    expect(all).toHaveLength(2);
    expect(all[0].wsId).toBe("ws-eng");
    expect(all[1].wsId).toBe("ws-eng");
  });

  test("register without wsId leaves wsId undefined", () => {
    const reg = new PlacementRegistry();
    reg.register("bash", [
      { slot: "sidebar", resourceUri: "ui://bash/nav" },
    ]);

    expect(reg.all()[0].wsId).toBeUndefined();
  });
});
