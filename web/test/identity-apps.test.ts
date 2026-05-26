import { describe, expect, it } from "bun:test";
import { IDENTITY_APP_SOURCES, identityAppRoute, isIdentityApp } from "../src/lib/identity-apps";

// The web mirror of the backend identity-source set. These pin the contract
// the bridge + sidebar + router depend on; keep this in lockstep with
// `Runtime.getIdentitySource` in src/.

describe("identity-apps", () => {
  it("recognizes conversations as a kernel identity app", () => {
    expect(isIdentityApp("conversations")).toBe(true);
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

  it("maps an identity app to its top-level root route", () => {
    expect(identityAppRoute("conversations")).toBe("/conversations");
  });

  it("v1 identity set is exactly { conversations }", () => {
    expect([...IDENTITY_APP_SOURCES]).toEqual(["conversations"]);
  });
});
