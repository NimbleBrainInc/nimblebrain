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
  it("recognizes conversations, files, and automations as kernel identity apps", () => {
    expect(isIdentityApp("conversations")).toBe(true);
    expect(isIdentityApp("files")).toBe(true);
    expect(isIdentityApp("automations")).toBe(true);
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
    expect(identityAppSegment("automations")).toBe("automations");
  });

  it("maps an identity app to its workspace-scoped view route", () => {
    // The view is workspace-scoped now (the slug = the focused workspace); the
    // tools still dispatch bare through the identity door.
    expect(identityAppRoute("conversations", "helix")).toBe("/w/helix/conversations");
    expect(identityAppRoute("files", "user_u1")).toBe("/w/user_u1/files");
    expect(identityAppRoute("automations", "acme")).toBe("/w/acme/automations");
  });

  it("identity set is exactly { conversations, files, automations }", () => {
    expect([...IDENTITY_APP_SOURCES]).toEqual(["conversations", "files", "automations"]);
  });
});
