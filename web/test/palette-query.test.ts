// ---------------------------------------------------------------------------
// Palette query logic — prefix scoping + grouping (pure).
//
//   parseQuery: leading @ / # / > sets scope and is stripped.
//   buildResultGroups: prefix narrows to one source; no prefix runs all;
//   empty groups dropped; apps group label names the focused workspace.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { buildResultGroups, parseQuery } from "../src/components/palette/query";
import { actionsSource } from "../src/components/palette/sources/actions";
import { appsSource } from "../src/components/palette/sources/apps";
import { workspacesSource } from "../src/components/palette/sources/workspaces";
import type { CommandSourceContext } from "../src/components/palette/types";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";
import type { PlacementEntry } from "../src/types";

const SOURCES = [workspacesSource, appsSource, actionsSource];

function ws(id: string, name: string, extra?: Partial<WorkspaceInfo>): WorkspaceInfo {
  return { id, name, memberCount: 1, bundles: [], ...extra };
}

const apps: PlacementEntry[] = [
  { serverName: "crm", slot: "sidebar.apps", resourceUri: "ui://crm", priority: 1, label: "CRM", route: "crm" },
];

const ctx: CommandSourceContext = {
  workspaces: [ws("ws_aaaaaaaaaaaaaaaa", "Pacific Clinic"), ws("ws_bbbbbbbbbbbbbbbb", "Helix Sales")],
  activeWorkspaceId: "ws_bbbbbbbbbbbbbbbb",
  activeWorkspaceName: "Helix Sales",
  activeWorkspaceSlug: "bbbbbbbbbbbbbbbb",
  apps,
  iconForApp: () => undefined,
  orgRole: "org_admin",
};

describe("parseQuery", () => {
  test("no prefix → no scope, full term", () => {
    expect(parseQuery("crm")).toEqual({ scopeId: null, term: "crm" });
  });

  test("@ scopes to workspaces and strips prefix", () => {
    expect(parseQuery("@pac")).toEqual({ scopeId: "workspaces", term: "pac" });
  });

  test("# scopes to apps", () => {
    expect(parseQuery("#crm")).toEqual({ scopeId: "apps", term: "crm" });
  });

  test("> scopes to actions", () => {
    expect(parseQuery(">settings")).toEqual({ scopeId: "actions", term: "settings" });
  });

  test("bare prefix → empty term", () => {
    expect(parseQuery("@")).toEqual({ scopeId: "workspaces", term: "" });
  });
});

describe("buildResultGroups", () => {
  test("empty default view is content-first: workspaces + apps, NOT actions", () => {
    const groups = buildResultGroups("", SOURCES, ctx);
    const ids = groups.map((g) => g.source.id);
    expect(ids).toContain("workspaces");
    expect(ids).toContain("apps");
    // Actions are a command mode — hidden until the user types or scopes with >.
    expect(ids).not.toContain("actions");
  });

  test("a non-empty term surfaces matching actions alongside content", () => {
    const groups = buildResultGroups("settings", SOURCES, ctx);
    expect(groups.some((g) => g.source.id === "actions")).toBe(true);
  });

  test("> scope shows actions even with no term", () => {
    const groups = buildResultGroups(">", SOURCES, ctx);
    expect(groups.map((g) => g.source.id)).toEqual(["actions"]);
  });

  test("@ prefix narrows to workspaces only", () => {
    const groups = buildResultGroups("@", SOURCES, ctx);
    expect(groups.map((g) => g.source.id)).toEqual(["workspaces"]);
  });

  test("# prefix narrows to apps and labels the group with the workspace", () => {
    const groups = buildResultGroups("#", SOURCES, ctx);
    expect(groups.map((g) => g.source.id)).toEqual(["apps"]);
    expect(groups[0]!.label).toBe("Apps in Helix Sales");
  });

  test("drops a group whose source returns nothing", () => {
    // # scope with a non-matching term → apps group is empty → no groups.
    const groups = buildResultGroups("#zzzz", SOURCES, ctx);
    expect(groups).toEqual([]);
  });
});
