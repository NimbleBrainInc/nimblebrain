// ---------------------------------------------------------------------------
// The top bar's page name for a route (lib/page-title).
//
// Pins the words the bar shows when no app trail overrides them: the sidebar
// row's own label for an app or identity view, a fixed name for the shell's
// own pages, and never the workspace name.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { pageTitle, settingsLocation } from "../src/lib/page-title";
import type { PlacementEntry } from "../src/types";

const placement = (over: Partial<PlacementEntry>): PlacementEntry => ({
  serverName: "people",
  slot: "sidebar.apps",
  resourceUri: "ui://people/main",
  priority: 100,
  ...over,
});

const PLACEMENTS = [
  placement({ serverName: "conversations", slot: "sidebar", label: "Conversations", route: "conversations" }),
  placement({ serverName: "people", label: "People", route: "people" }),
  placement({ serverName: "tasks", route: "tasks" }),
];

describe("pageTitle", () => {
  test("the shell's own pages", () => {
    expect(pageTitle("/", PLACEMENTS)).toBe("Home");
    expect(pageTitle("/profile/general", PLACEMENTS)).toBe("General");
    expect(pageTitle("/org/workspaces", PLACEMENTS)).toBe("Workspaces");
    expect(pageTitle("/org/about", PLACEMENTS)).toBe("About");
  });

  test("workspace pages, without the workspace's name", () => {
    expect(pageTitle("/w/000f7ed6658f9d30/", PLACEMENTS)).toBe("Overview");
    expect(pageTitle("/w/000f7ed6658f9d30/notifications", PLACEMENTS)).toBe("Inbox");
    expect(pageTitle("/w/000f7ed6658f9d30/context/conv-1", PLACEMENTS)).toBe("Context");
  });

  test("a settings tab is named as its nav names it, deeper routes by their tab", () => {
    expect(pageTitle("/w/000f7ed6658f9d30/settings/general", PLACEMENTS)).toBe("General");
    expect(pageTitle("/w/000f7ed6658f9d30/settings/members", PLACEMENTS)).toBe("Members");
    expect(pageTitle("/w/000f7ed6658f9d30/settings/connectors", PLACEMENTS)).toBe("Connectors");
    expect(pageTitle("/w/000f7ed6658f9d30/settings/connectors/browse", PLACEMENTS)).toBe("Connectors");
  });

  test("a settings tab follows a crumb back to its area's first tab", () => {
    expect(settingsLocation("/w/000f7ed6658f9d30/settings/members")).toEqual({
      crumbs: [{ label: "Settings", to: "/w/000f7ed6658f9d30/settings/general" }],
      title: "Members",
    });
    expect(settingsLocation("/org/users")).toEqual({
      crumbs: [{ label: "Organization", to: "/org/workspaces" }],
      title: "Users",
    });
    expect(settingsLocation("/profile/skills")).toEqual({
      crumbs: [{ label: "Profile", to: "/profile/general" }],
      title: "Skills",
    });
    // An unknown tab names the area, with nothing to go back to.
    expect(settingsLocation("/w/000f7ed6658f9d30/settings/gone")).toEqual({
      crumbs: [],
      title: "Settings",
    });
    expect(settingsLocation("/w/000f7ed6658f9d30/app/people")).toBeNull();
  });

  test("an app or identity view takes its sidebar label, falling back to its route", () => {
    expect(pageTitle("/w/000f7ed6658f9d30/app/people", PLACEMENTS)).toBe("People");
    expect(pageTitle("/w/000f7ed6658f9d30/app/tasks", PLACEMENTS)).toBe("tasks");
    expect(pageTitle("/w/000f7ed6658f9d30/conversations", PLACEMENTS)).toBe("Conversations");
  });

  test("an unknown route names nothing", () => {
    expect(pageTitle("/w/000f7ed6658f9d30/app/gone", PLACEMENTS)).toBe("");
    expect(pageTitle("/elsewhere", PLACEMENTS)).toBe("");
  });
});
