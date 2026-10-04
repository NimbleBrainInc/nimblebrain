// An app's notice is labelled with the name the sidebar shows for it, from its
// page and from a chat alike: an installed connector's display name, else a
// built-in's sidebar label, else server name.

import { describe, expect, test } from "bun:test";
import { appDisplayName } from "../lib/app-name";
import type { PlacementEntry } from "../types";

const placement = (serverName: string, label?: string): PlacementEntry =>
  ({
    serverName,
    slot: "sidebar.apps",
    resourceUri: `ui://${serverName}/main`,
    priority: 10,
    ...(label ? { label } : {}),
  }) as PlacementEntry;

describe("appDisplayName", () => {
  test("an installed connector is named by its catalog title, not its view's label", () => {
    const installed = [{ serverName: "synapse-crm", displayName: "People" }];
    expect(appDisplayName("synapse-crm", installed, [placement("synapse-crm", "Contacts")])).toBe(
      "People",
    );
  });

  test("a built-in app with no connector is named by its sidebar label", () => {
    expect(appDisplayName("files", [], [placement("files", "Files")])).toBe("Files");
  });

  test("with neither, the server name", () => {
    expect(appDisplayName("echo", undefined, [])).toBe("echo");
  });
});
