import { describe, expect, it } from "bun:test";
import { resolveDefaultTimezone } from "../../../../src/platform/automations/source.ts";

describe("resolveDefaultTimezone", () => {
  it("keeps a timezone Intl knows", () => {
    expect(resolveDefaultTimezone("America/New_York")).toBe("America/New_York");
  });

  it("falls back when NB_TIMEZONE is unset", () => {
    expect(resolveDefaultTimezone(undefined)).toBe("Pacific/Honolulu");
  });

  it("falls back instead of passing an unknown name to the budget and next-run paths", () => {
    expect(resolveDefaultTimezone("Not/AZone")).toBe("Pacific/Honolulu");
  });
});
