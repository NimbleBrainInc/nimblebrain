import { describe, expect, test } from "bun:test";
import { PlacementRegistry } from "../../src/runtime/placement-registry.ts";

describe("PlacementRegistry", () => {
  test("forWorkspace returns ambient entries merged with scoped ones", () => {
    const reg = new PlacementRegistry();
    // Ambient — platform sources like Home, Conversations, Files.
    reg.register("nb", [
      { slot: "sidebar", resourceUri: "ui://core/home", priority: 10 },
      { slot: "sidebar", resourceUri: "ui://core/conversations", priority: 20 },
    ]);
    // Scoped — a bundle installed in ws_eng.
    reg.register(
      "tasks",
      [{ slot: "sidebar.apps", resourceUri: "ui://tasks/nav", priority: 50 }],
      "ws_eng",
    );

    const eng = reg.forWorkspace("ws_eng");
    expect(eng).toHaveLength(3);
    // Sorted by slot then priority — sidebar (ambient) before sidebar.apps (scoped).
    expect(eng[0].resourceUri).toBe("ui://core/home");
    expect(eng[1].resourceUri).toBe("ui://core/conversations");
    expect(eng[2].resourceUri).toBe("ui://tasks/nav");
  });

  test("forWorkspace isolates scoped entries across workspaces", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [{ slot: "sidebar", resourceUri: "ui://core/home" }]);
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks" }], "ws_eng");
    reg.register("crm", [{ slot: "main", resourceUri: "ui://crm" }], "ws_sales");

    const eng = reg.forWorkspace("ws_eng");
    const sales = reg.forWorkspace("ws_sales");

    // Each workspace sees ambient + its own scoped entries, never the other's.
    // Sort is slot-alphabetical: "main" before "sidebar".
    expect(eng.map((e) => e.resourceUri)).toEqual(["ui://tasks", "ui://core/home"]);
    expect(sales.map((e) => e.resourceUri)).toEqual(["ui://crm", "ui://core/home"]);
  });

  test("forWorkspace returns only ambient when workspace has no scoped entries", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [{ slot: "sidebar", resourceUri: "ui://core/home" }]);

    const entries = reg.forWorkspace("ws_new");
    expect(entries).toHaveLength(1);
    expect(entries[0].resourceUri).toBe("ui://core/home");
  });

  test("unregister scoped to (serverName, wsId) leaves other workspaces untouched", () => {
    const reg = new PlacementRegistry();
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks" }], "ws_eng");
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks" }], "ws_sales");

    reg.unregister("tasks", "ws_eng");

    expect(reg.forWorkspace("ws_eng")).toHaveLength(0);
    expect(reg.forWorkspace("ws_sales")).toHaveLength(1);
  });

  test("unregister without wsId removes only ambient entries", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [{ slot: "sidebar", resourceUri: "ui://core/home" }]);
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks" }], "ws_eng");

    reg.unregister("nb"); // ambient

    const eng = reg.forWorkspace("ws_eng");
    expect(eng).toHaveLength(1);
    expect(eng[0].resourceUri).toBe("ui://tasks");
  });

  test("duplicate register replaces prior entries for the same (serverName, wsId)", () => {
    const reg = new PlacementRegistry();
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks/v1" }], "ws_eng");
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks/v2" }], "ws_eng");

    const eng = reg.forWorkspace("ws_eng");
    expect(eng).toHaveLength(1);
    expect(eng[0].resourceUri).toBe("ui://tasks/v2");
  });

  test("default priority is 100", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [{ slot: "main", resourceUri: "ui://core/page" }]);

    expect(reg.forWorkspace("ws_any")[0].priority).toBe(100);
  });

  test("register with wsId sets wsId on every inserted entry", () => {
    const reg = new PlacementRegistry();
    reg.register(
      "echo",
      [
        { slot: "sidebar.apps", resourceUri: "ui://echo/nav" },
        { slot: "main", resourceUri: "ui://echo/page" },
      ],
      "ws_eng",
    );

    const eng = reg.forWorkspace("ws_eng");
    expect(eng).toHaveLength(2);
    expect(eng.every((e) => e.wsId === "ws_eng")).toBe(true);
  });

  test("register without wsId leaves wsId undefined (ambient)", () => {
    const reg = new PlacementRegistry();
    reg.register("bash", [{ slot: "sidebar", resourceUri: "ui://bash/nav" }]);

    const anyWs = reg.forWorkspace("ws_anything");
    expect(anyWs[0].wsId).toBeUndefined();
  });
});
