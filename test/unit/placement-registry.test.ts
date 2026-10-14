import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import type { PlacementDeclaration } from "../../src/connectors/runtime/types.ts";
import { log } from "../../src/observability/log.ts";
import { PlacementRegistry, placementRouteKey } from "../../src/runtime/placement-registry.ts";

describe("PlacementRegistry", () => {
  test("forWorkspace returns ambient entries merged with scoped ones", () => {
    const reg = new PlacementRegistry();
    // Ambient — platform sources like Home, Conversations, Files.
    reg.register("nb", [
      { slot: "sidebar", resourceUri: "ui://core/home", priority: 10 },
      { slot: "sidebar", resourceUri: "ui://core/conversations", priority: 20 },
    ]);
    // Scoped — a connector installed in ws_002fbb9fda6654ca.
    reg.register(
      "tasks",
      [{ slot: "sidebar.apps", resourceUri: "ui://tasks/nav", priority: 50 }],
      "ws_002fbb9fda6654ca",
    );

    const eng = reg.forWorkspace("ws_002fbb9fda6654ca");
    expect(eng).toHaveLength(3);
    // Sorted by slot then priority — sidebar (ambient) before sidebar.apps (scoped).
    expect(eng[0].resourceUri).toBe("ui://core/home");
    expect(eng[1].resourceUri).toBe("ui://core/conversations");
    expect(eng[2].resourceUri).toBe("ui://tasks/nav");
  });

  test("forWorkspace isolates scoped entries across workspaces", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [{ slot: "sidebar", resourceUri: "ui://core/home" }]);
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks" }], "ws_002fbb9fda6654ca");
    reg.register("crm", [{ slot: "main", resourceUri: "ui://crm" }], "ws_006a3c0eb78706fc");

    const eng = reg.forWorkspace("ws_002fbb9fda6654ca");
    const sales = reg.forWorkspace("ws_006a3c0eb78706fc");

    // Each workspace sees ambient + its own scoped entries, never the other's.
    // Sort is slot-alphabetical: "main" before "sidebar".
    expect(eng.map((e) => e.resourceUri)).toEqual(["ui://tasks", "ui://core/home"]);
    expect(sales.map((e) => e.resourceUri)).toEqual(["ui://crm", "ui://core/home"]);
  });

  test("forWorkspace returns only ambient when workspace has no scoped entries", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [{ slot: "sidebar", resourceUri: "ui://core/home" }]);

    const entries = reg.forWorkspace("ws_004dbf07470f1e9d");
    expect(entries).toHaveLength(1);
    expect(entries[0].resourceUri).toBe("ui://core/home");
  });

  test("unregister scoped to (serverName, wsId) leaves other workspaces untouched", () => {
    const reg = new PlacementRegistry();
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks" }], "ws_002fbb9fda6654ca");
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks" }], "ws_006a3c0eb78706fc");

    reg.unregister("tasks", "ws_002fbb9fda6654ca");

    expect(reg.forWorkspace("ws_002fbb9fda6654ca")).toHaveLength(0);
    expect(reg.forWorkspace("ws_006a3c0eb78706fc")).toHaveLength(1);
  });

  test("unregister without wsId removes only ambient entries", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [{ slot: "sidebar", resourceUri: "ui://core/home" }]);
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks" }], "ws_002fbb9fda6654ca");

    reg.unregister("nb"); // ambient

    const eng = reg.forWorkspace("ws_002fbb9fda6654ca");
    expect(eng).toHaveLength(1);
    expect(eng[0].resourceUri).toBe("ui://tasks");
  });

  test("duplicate register replaces prior entries for the same (serverName, wsId)", () => {
    const reg = new PlacementRegistry();
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks/v1" }], "ws_002fbb9fda6654ca");
    reg.register("tasks", [{ slot: "main", resourceUri: "ui://tasks/v2" }], "ws_002fbb9fda6654ca");

    const eng = reg.forWorkspace("ws_002fbb9fda6654ca");
    expect(eng).toHaveLength(1);
    expect(eng[0].resourceUri).toBe("ui://tasks/v2");
  });

  test("default priority is 100", () => {
    const reg = new PlacementRegistry();
    reg.register("nb", [{ slot: "main", resourceUri: "ui://core/page" }]);

    expect(reg.forWorkspace("ws_001823913791bb9c")[0].priority).toBe(100);
  });

  test("register with wsId sets wsId on every inserted entry", () => {
    const reg = new PlacementRegistry();
    reg.register(
      "echo",
      [
        { slot: "sidebar.apps", resourceUri: "ui://echo/nav" },
        { slot: "main", resourceUri: "ui://echo/page" },
      ],
      "ws_002fbb9fda6654ca",
    );

    const eng = reg.forWorkspace("ws_002fbb9fda6654ca");
    expect(eng).toHaveLength(2);
    expect(eng.every((e) => e.wsId === "ws_002fbb9fda6654ca")).toBe(true);
  });

  test("register without wsId leaves wsId undefined (ambient)", () => {
    const reg = new PlacementRegistry();
    reg.register("bash", [{ slot: "sidebar", resourceUri: "ui://bash/nav" }]);

    const anyWs = reg.forWorkspace("ws_00194decd292a0f6");
    expect(anyWs[0].wsId).toBeUndefined();
  });
});

describe("PlacementRegistry route ownership", () => {
  // The platform's Conversations placement, as `src/platform/conversations` declares it.
  const conversations: PlacementDeclaration = {
    slot: "sidebar",
    resourceUri: "ui://conversations/browser",
    route: "@nimblebraininc/conversations",
    label: "Conversations",
    priority: 1,
  };

  function app(name: string, route: string, priority = 0): PlacementDeclaration {
    return { slot: "sidebar.apps", resourceUri: `ui://${name}/main`, route, label: name, priority };
  }

  let warn: Mock<typeof log.warn>;
  beforeEach(() => {
    warn = spyOn(log, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  test("a connector placement on a platform route is refused, with a warning", () => {
    const reg = new PlacementRegistry();
    reg.register("conversations", [conversations]);
    reg.register(
      "acme-corp",
      [app("acme-corp", "@nimblebraininc/conversations"), app("acme-corp", "@acme-corp/home")],
      "ws_a",
    );

    const routes = reg.forWorkspace("ws_a").map((e) => `${e.serverName} ${e.route}`);
    expect(routes).toEqual([
      "conversations @nimblebraininc/conversations",
      "acme-corp @acme-corp/home",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      serverName: "acme-corp",
      wsId: "ws_a",
      route: "@nimblebraininc/conversations",
      heldBy: "conversations",
    });
  });

  test("a platform source registered after a connector takes its route back", () => {
    const reg = new PlacementRegistry();
    reg.register("acme-corp", [app("acme-corp", "@NimbleBrainInc/Conversations/")], "ws_a");
    reg.register("conversations", [conversations]);

    expect(reg.forWorkspace("ws_a").map((e) => e.serverName)).toEqual(["conversations"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      serverName: "acme-corp",
      heldBy: "conversations",
    });
  });

  test("between connectors in one workspace, the first registered keeps the route", () => {
    const reg = new PlacementRegistry();
    reg.register("tenant-a-crm", [app("tenant-a-crm", "@acme-corp/crm", 50)], "ws_a");
    reg.register("tenant-b-crm", [app("tenant-b-crm", "@acme-corp/crm", 0)], "ws_a");
    // Re-registering the holder (a reconnect) keeps it; the loser stays out.
    reg.register("tenant-a-crm", [app("tenant-a-crm", "@acme-corp/crm", 50)], "ws_a");

    expect(reg.forWorkspace("ws_a").map((e) => e.serverName)).toEqual(["tenant-a-crm"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      serverName: "tenant-b-crm",
      heldBy: "tenant-a-crm",
    });
  });

  test("a connector sharing a platform source's name still cannot take its route", () => {
    const reg = new PlacementRegistry();
    reg.register("conversations", [conversations]);
    reg.register("conversations", [app("conversations", "@nimblebraininc/conversations")], "ws_a");

    expect(reg.forWorkspace("ws_a").map((e) => e.wsId)).toEqual([undefined]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("the same route in two workspaces is no collision", () => {
    const reg = new PlacementRegistry();
    reg.register("tenant-a-crm", [app("tenant-a-crm", "@acme-corp/crm")], "ws_a");
    reg.register("tenant-b-crm", [app("tenant-b-crm", "@acme-corp/crm")], "ws_b");

    expect(reg.forWorkspace("ws_a").map((e) => e.serverName)).toEqual(["tenant-a-crm"]);
    expect(reg.forWorkspace("ws_b").map((e) => e.serverName)).toEqual(["tenant-b-crm"]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("distinct routes and placements without a route are unaffected", () => {
    const reg = new PlacementRegistry();
    reg.register("conversations", [conversations]);
    reg.register(
      "tasks",
      [
        app("tasks", "@nimblebraininc/tasks"),
        { slot: "settings", resourceUri: "ui://tasks/settings" },
      ],
      "ws_a",
    );
    reg.register("people", [app("people", "@nimblebraininc/people")], "ws_a");

    expect(reg.forWorkspace("ws_a")).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled();
  });

  test("placementRouteKey folds case, escapes, and repeated or edge slashes", () => {
    expect(placementRouteKey("/%40Acme-Corp//CRM/")).toBe("@acme-corp/crm");
    expect(placementRouteKey("%E0%A4%A")).toBe("%e0%a4%a");
  });
});
