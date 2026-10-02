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
    expect(pageTitle("/w/acme/", PLACEMENTS)).toBe("Overview");
    expect(pageTitle("/w/acme/notifications", PLACEMENTS)).toBe("Inbox");
    expect(pageTitle("/w/acme/context/conv-1", PLACEMENTS)).toBe("Context");
  });

  test("settings: the Connectors row's tab keeps its name; every other tab is Settings", () => {
    expect(pageTitle("/w/acme/settings/connectors", PLACEMENTS)).toBe("Connectors");
    expect(pageTitle("/w/acme/settings/connectors/browse", PLACEMENTS)).toBe("Connectors");
    expect(pageTitle("/w/acme/settings/general", PLACEMENTS)).toBe("Settings");
  });

  test("an app or identity view takes its sidebar label, falling back to its route", () => {
    expect(pageTitle("/w/acme/app/people", PLACEMENTS)).toBe("People");
    expect(pageTitle("/w/acme/app/tasks", PLACEMENTS)).toBe("tasks");
    expect(pageTitle("/w/acme/conversations", PLACEMENTS)).toBe("Conversations");
  });

  test("an unknown route names nothing", () => {
    expect(pageTitle("/w/acme/app/gone", PLACEMENTS)).toBe("");
    expect(pageTitle("/elsewhere", PLACEMENTS)).toBe("");
  });
});
