// ---------------------------------------------------------------------------
// Command palette sources — behavior contracts.
//
//   workspaces: excludes the focused workspace; matches by name + role.
//   apps:       empty when shell not ready (no apps) or no focused workspace;
//               builds /w/<slug>/app/<route> on run.
//   actions:    availability gating (focused-ws-only, org-admin-only); run
//               closes over the source context for workspace routes.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { appsSource } from "../src/components/palette/sources/apps";
import { actionsSource } from "../src/components/palette/sources/actions";
import { workspacesSource } from "../src/components/palette/sources/workspaces";
import type { CommandRunContext, CommandSourceContext } from "../src/components/palette/types";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";
import type { PlacementEntry } from "../src/types";

function ws(id: string, name: string, extra?: Partial<WorkspaceInfo>): WorkspaceInfo {
  return { id, name, memberCount: 1, bundles: [], ...extra };
}

const baseCtx: CommandSourceContext = {
  workspaces: [],
  apps: [],
  iconForApp: () => undefined,
};

function recordRunContext(): {
  ctx: CommandRunContext;
  calls: { navigate: string[]; setActiveWorkspace: string[]; closed: number };
} {
  const calls = { navigate: [] as string[], setActiveWorkspace: [] as string[], closed: 0 };
  const ctx: CommandRunContext = {
    navigate: (to) => calls.navigate.push(to),
    setActiveWorkspace: (w) => calls.setActiveWorkspace.push(w.id),
    toggleChat: () => {},
    toggleSidebar: () => {},
    toggleTheme: () => {},
    openKeyboardShortcuts: () => {},
    logout: () => {},
    closePalette: () => {
      calls.closed += 1;
    },
  };
  return { ctx, calls };
}

describe("workspacesSource", () => {
  const ctx: CommandSourceContext = {
    ...baseCtx,
    workspaces: [
      ws("ws_aaaaaaaaaaaaaaaa", "Pacific Clinic", { userRole: "member" }),
      ws("ws_bbbbbbbbbbbbbbbb", "Personal", { userRole: "admin", isPersonal: true }),
      ws("ws_cccccccccccccccc", "Helix Sales", { userRole: "admin" }),
    ],
    activeWorkspaceId: "ws_cccccccccccccccc",
  };

  test("includes all workspaces with the focused one sorted last", () => {
    const items = workspacesSource.getItems("", ctx);
    expect(items.length).toBe(3);
    // Helix Sales is the focused workspace → sinks to the bottom.
    expect(items.at(-1)?.title).toBe("Helix Sales");
    expect(items.at(-1)?.subtitle).toContain("current");
  });

  test("matches by name", () => {
    const items = workspacesSource.getItems("pac", ctx);
    expect(items.map((i) => i.title)).toEqual(["Pacific Clinic"]);
  });

  test("run switches workspace and navigates to overview", () => {
    const items = workspacesSource.getItems("pacific", ctx);
    const { ctx: run, calls } = recordRunContext();
    items[0]!.run(run);
    expect(calls.setActiveWorkspace).toEqual(["ws_aaaaaaaaaaaaaaaa"]);
    expect(calls.navigate).toEqual(["/w/aaaaaaaaaaaaaaaa/"]);
    expect(calls.closed).toBe(1);
  });
});

describe("appsSource", () => {
  const apps: PlacementEntry[] = [
    { serverName: "crm", slot: "sidebar.apps", resourceUri: "ui://crm", priority: 1, label: "CRM", route: "crm" },
    { serverName: "pipeline", slot: "sidebar.apps", resourceUri: "ui://pipe", priority: 2, label: "Pipeline", route: "pipeline" },
  ];

  test("returns empty when shell not ready (no apps)", () => {
    const items = appsSource.getItems("", {
      ...baseCtx,
      activeWorkspaceSlug: "helix",
      apps: [],
    });
    expect(items).toEqual([]);
  });

  test("returns empty when no workspace focused", () => {
    expect(appsSource.getItems("", { ...baseCtx, apps })).toEqual([]);
  });

  test("matches apps and builds workspace-scoped route on run", () => {
    const ctx = { ...baseCtx, activeWorkspaceSlug: "helix", apps };
    const items = appsSource.getItems("crm", ctx);
    expect(items.map((i) => i.title)).toEqual(["CRM"]);
    const { ctx: run, calls } = recordRunContext();
    items[0]!.run(run);
    expect(calls.navigate).toEqual(["/w/helix/app/crm"]);
    expect(calls.closed).toBe(1);
  });
});

describe("actionsSource", () => {
  test("hides workspace-scoped actions without a focused workspace", () => {
    const ids = actionsSource.getItems("", baseCtx).map((i) => i.id);
    expect(ids).not.toContain("action:workspace-settings");
    expect(ids).not.toContain("action:manage-connectors");
  });

  test("shows workspace-scoped actions when a workspace is focused", () => {
    const ids = actionsSource
      .getItems("", { ...baseCtx, activeWorkspaceSlug: "helix" })
      .map((i) => i.id);
    expect(ids).toContain("action:workspace-settings");
  });

  test("hides org settings for non-admins, shows for org_admin", () => {
    expect(actionsSource.getItems("org", baseCtx).map((i) => i.id)).not.toContain(
      "action:org-settings",
    );
    expect(
      actionsSource.getItems("org", { ...baseCtx, orgRole: "org_admin" }).map((i) => i.id),
    ).toContain("action:org-settings");
  });

  test("workspace-settings run builds the scoped route", () => {
    const items = actionsSource.getItems("workspace settings", {
      ...baseCtx,
      activeWorkspaceSlug: "helix",
    });
    const item = items.find((i) => i.id === "action:workspace-settings");
    expect(item).toBeDefined();
    const { ctx: run, calls } = recordRunContext();
    item!.run(run);
    expect(calls.navigate).toEqual(["/w/helix/settings"]);
  });
});
