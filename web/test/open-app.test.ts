// ---------------------------------------------------------------------------
// Opening an app at a view (lib/open-app): the shell side of `openApp` and the
// agent's `nb__open_app`.
//
// Pins: the open-app tool is recognized by its wire name; a
// route's state yields its target only when it carries one; and an app name
// resolves the way the server's `findOpenableApp` does, with identity views
// at their own path under the workspace rather than under `app/`.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { appTargetFrom, isOpenAppCall, resolveAppRouteIn } from "../src/lib/open-app";
import type { PlacementEntry } from "../src/types";

const placement = (over: Partial<PlacementEntry>): PlacementEntry => ({
  serverName: "people",
  slot: "sidebar.apps",
  resourceUri: "ui://people/main",
  priority: 100,
  ...over,
});

const PLACEMENTS = [
  placement({ serverName: "people", label: "People", route: "people" }),
  placement({ serverName: "conversations", slot: "sidebar", label: "Conversations", route: "conversations" }),
  placement({ serverName: "widget", label: "Widget" }),
];

describe("isOpenAppCall", () => {
  test("the nb source's open_app, and nothing else", () => {
    expect(isOpenAppCall("nb__open_app")).toBe(true);
    expect(isOpenAppCall("nb__status")).toBe(false);
    expect(isOpenAppCall("people__open_app")).toBe(false);
  });
});

describe("appTargetFrom", () => {
  test("reads a non-empty string target and nothing else", () => {
    expect(appTargetFrom({ appTarget: "people://contacts/1" })).toBe("people://contacts/1");
    expect(appTargetFrom({ appTarget: "" })).toBeUndefined();
    expect(appTargetFrom({ appTarget: 7 })).toBeUndefined();
    expect(appTargetFrom(null)).toBeUndefined();
    expect(appTargetFrom(undefined)).toBeUndefined();
  });
});

describe("resolveAppRouteIn", () => {
  test("an app resolves by route, server name, or label to its app route", () => {
    expect(resolveAppRouteIn(PLACEMENTS, "people", "acme")).toBe("people");
    expect(resolveAppRouteIn(PLACEMENTS, "People", "acme")).toBe("people");
  });

  test("an identity view resolves to its own path under the workspace", () => {
    expect(resolveAppRouteIn(PLACEMENTS, "Conversations", "acme")).toBe("/w/acme/conversations");
    expect(resolveAppRouteIn(PLACEMENTS, "conversations", null)).toBeNull();
  });

  test("an unknown or unrouted app resolves to nothing", () => {
    expect(resolveAppRouteIn(PLACEMENTS, "Payroll", "acme")).toBeNull();
    expect(resolveAppRouteIn(PLACEMENTS, "Widget", "acme")).toBeNull();
  });
});
