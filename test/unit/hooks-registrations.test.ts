import { describe, expect, test } from "bun:test";
import {
  findRegistration,
  isKidAdmissible,
  listRegistrations,
  registrationKey,
  withRotatedKid,
} from "../../src/hooks/registrations.ts";
import { HOOK_ROTATION_GRACE_MS, type HookRegistration } from "../../src/hooks/types.ts";

const NOW = Date.parse("2026-08-28T00:00:00.000Z");

function reg(over: Partial<HookRegistration> = {}): HookRegistration {
  return {
    connector: "acme-mcp",
    vendor: "acme",
    kid: "hk_current",
    createdAt: new Date(NOW).toISOString(),
    route: "/ingest/acme",
    ...over,
  };
}

describe("withRotatedKid", () => {
  test("a first mint has no previous kid and no rotation stamp", () => {
    const r = withRotatedKid(undefined, {
      connector: "acme-mcp",
      vendor: "acme",
      kid: "hk_first",
      route: "/ingest/acme",
    });
    expect(r.kid).toBe("hk_first");
    expect(r.prevKid).toBeUndefined();
    expect(r.rotatedAt).toBeUndefined();
  });

  test("a rotation carries the outgoing kid into the grace window", () => {
    const iso = new Date(NOW).toISOString();
    const r = withRotatedKid(
      reg({ kid: "hk_old", createdAt: "2026-01-01T00:00:00.000Z" }),
      { connector: "acme-mcp", vendor: "acme", kid: "hk_new", route: "/ingest/acme" },
      iso,
    );
    expect(r.kid).toBe("hk_new");
    expect(r.prevKid).toBe("hk_old");
    expect(r.rotatedAt).toBe(iso);
    // The stream's identity predates the rotation and must survive it.
    expect(r.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("a rotation refreshes the recorded route", () => {
    const r = withRotatedKid(
      reg(),
      { connector: "acme-mcp", vendor: "acme", kid: "hk_new", route: "/ingest/v2" },
      new Date(NOW).toISOString(),
    );
    expect(r.route).toBe("/ingest/v2");
  });
});

describe("isKidAdmissible", () => {
  test("admits the current kid", () => {
    expect(isKidAdmissible(reg(), "hk_current", NOW)).toBe(true);
  });

  test("admits the previous kid inside the grace window", () => {
    const r = reg({
      prevKid: "hk_old",
      rotatedAt: new Date(NOW - HOOK_ROTATION_GRACE_MS + 60_000).toISOString(),
    });
    // A redelivery queued against the old URL before the server re-registered
    // still has to land, or a routine rotation loses whatever was in flight.
    expect(isKidAdmissible(r, "hk_old", NOW)).toBe(true);
  });

  test("refuses the previous kid once the grace window closes", () => {
    const r = reg({
      prevKid: "hk_old",
      rotatedAt: new Date(NOW - HOOK_ROTATION_GRACE_MS - 1).toISOString(),
    });
    expect(isKidAdmissible(r, "hk_old", NOW)).toBe(false);
  });

  test.each([
    ["an unknown kid", "hk_never"],
    ["a kid from two rotations ago", "hk_ancient"],
    ["an empty kid", ""],
  ])("refuses %s", (_label, kid) => {
    const r = reg({ prevKid: "hk_old", rotatedAt: new Date(NOW).toISOString() });
    expect(isKidAdmissible(r, kid, NOW)).toBe(false);
  });

  test("refuses a previous kid whose rotation stamp is missing or unparseable", () => {
    expect(isKidAdmissible(reg({ prevKid: "hk_old" }), "hk_old", NOW)).toBe(false);
    expect(
      isKidAdmissible(reg({ prevKid: "hk_old", rotatedAt: "not-a-date" }), "hk_old", NOW),
    ).toBe(false);
  });
});

describe("lookup", () => {
  const ws = {
    hooks: {
      [registrationKey("acme-mcp", "acme")]: reg(),
      [registrationKey("beta-mcp", "beta")]: reg({ connector: "beta-mcp", vendor: "beta" }),
    },
  };

  test("finds a registration by connector and vendor", () => {
    expect(findRegistration(ws, "acme-mcp", "acme")?.kid).toBe("hk_current");
  });

  test.each([
    ["a connector that has none", "other-mcp", "acme"],
    ["a vendor the connector does not declare", "acme-mcp", "beta"],
  ])("returns nothing for %s", (_label, connector, vendor) => {
    expect(findRegistration(ws, connector, vendor)).toBeUndefined();
  });

  test("a workspace with no hooks reads as empty", () => {
    expect(findRegistration({}, "acme-mcp", "acme")).toBeUndefined();
    expect(listRegistrations({})).toEqual([]);
  });

  test("lists in a stable order", () => {
    expect(listRegistrations(ws).map((r) => r.connector)).toEqual(["acme-mcp", "beta-mcp"]);
  });
});
