/**
 * The placement route comparison lives in two places: the registry, which
 * refuses a colliding connector placement, and the web shell, which cannot
 * import from `src/` and keeps a mirror for its own dedupe. They must agree,
 * or a route the server counts as free could still collide in the router.
 */

import { describe, expect, test } from "bun:test";
import { placementRouteKey as serverKey } from "../../src/runtime/placement-registry.ts";
import { placementRouteKey as webKey } from "../../web/src/lib/routable-placements.ts";

const CASES: Array<[route: string, expected: string]> = [
  ["@nimblebraininc/conversations", "@nimblebraininc/conversations"],
  ["@NimbleBrainInc/Conversations", "@nimblebraininc/conversations"],
  ["%40nimblebraininc/conversations", "@nimblebraininc/conversations"],
  ["/@nimblebraininc//conversations/", "@nimblebraininc/conversations"],
  ["crm/companies", "crm/companies"],
  ["/", ""],
  // A malformed escape is compared raw.
  ["%E0%A4%A", "%e0%a4%a"],
];

describe("placementRouteKey parity", () => {
  for (const [route, expected] of CASES) {
    test(route, () => {
      expect(serverKey(route)).toBe(expected);
      expect(webKey(route)).toBe(expected);
    });
  }
});
