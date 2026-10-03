// ---------------------------------------------------------------------------
// The top bar's page name for a route (lib/page-title).
//
// Pins the words the bar shows when no app trail overrides them: the sidebar
// row's own label for an app or identity view, a fixed name for the shell's
// own pages, and never the workspace name.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { pageTitle } from "../src/lib/page-title";
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
    expect(pageTitle("/profile/general", PLACEMENTS)).toBe("Profile");
    expect(pageTitle("/org/workspaces", PLACEMENTS)).toBe("Organization");
  });

  test("workspace pages, without the workspace's name", () => {
    expect(pageTitle("/w/000f7ed6658f9d30/", PLACEMENTS)).toBe("Overview");
    expect(pageTitle("/w/000f7ed6658f9d30/notifications", PLACEMENTS)).toBe("Inbox");
    expect(pageTitle("/w/000f7ed6658f9d30/context/conv-1", PLACEMENTS)).toBe("Context");
  });

  test("settings: the Connectors row's tab keeps its name; every other tab is Settings", () => {
    expect(pageTitle("/w/000f7ed6658f9d30/settings/connectors", PLACEMENTS)).toBe("Connectors");
    expect(pageTitle("/w/000f7ed6658f9d30/settings/connectors/browse", PLACEMENTS)).toBe("Connectors");
    expect(pageTitle("/w/000f7ed6658f9d30/settings/general", PLACEMENTS)).toBe("Settings");
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
