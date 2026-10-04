import { describe, expect, it } from "bun:test";
import {
  IDENTITY_APP_SOURCES,
  identityAppRoute,
  identityAppSegment,
  isIdentityApp,
} from "../src/lib/identity-apps";

// The web mirror of the backend identity-source set. These pin the contract
// the bridge + sidebar + router depend on; keep this in lockstep with
// `Runtime.getIdentitySource` in src/.

describe("identity-apps", () => {
  it("recognizes conversations, files, and tasks as kernel identity apps", () => {
    expect(isIdentityApp("conversations")).toBe(true);
    expect(isIdentityApp("files")).toBe(true);
    expect(isIdentityApp("tasks")).toBe(true);
  });

  it("treats workspace apps and the platform nb source as NOT identity apps", () => {
    expect(isIdentityApp("crm")).toBe(false);
    expect(isIdentityApp("nb")).toBe(false);
  });

  it("keys on the source/server name, not the placement route", () => {
    // The bridge resolves `server` to the serverName ("conversations"), and the
    // resource host's :name is the serverName too — NOT the placement route
    // "@nimblebraininc/conversations". A route-keyed check would silently miss.
    expect(isIdentityApp("@nimblebraininc/conversations")).toBe(false);
  });

  it("the route segment is the bare source name (relative under /w/:slug)", () => {
    expect(identityAppSegment("conversations")).toBe("conversations");
    expect(identityAppSegment("files")).toBe("files");
    expect(identityAppSegment("tasks")).toBe("tasks");
  });

  it("maps an identity app to its workspace-scoped view route", () => {
    // The view is workspace-scoped now (the slug = the focused workspace); the
    // tools still dispatch bare through the identity door.
    expect(identityAppRoute("conversations", "003eba8844413cd9")).toBe("/w/003eba8844413cd9/conversations");
    expect(identityAppRoute("files", "007dc0488ce56f9e")).toBe("/w/007dc0488ce56f9e/files");
    expect(identityAppRoute("tasks", "000f7ed6658f9d30")).toBe("/w/000f7ed6658f9d30/tasks");
  });

  it("identity set is exactly { conversations, files, tasks }", () => {
    expect([...IDENTITY_APP_SOURCES]).toEqual(["conversations", "files", "tasks"]);
  });
});
