import { describe, expect, test } from "bun:test";
import { shortSchedule } from "./schedule-label.ts";

describe("shortSchedule", () => {
  test("drops 'at', ':00', and the viewer's own timezone", () => {
    expect(shortSchedule("Weekdays at 7:00 AM HST", "HST")).toBe("Weekdays 7 AM");
    expect(shortSchedule("Mondays at 8:30 AM HST", "HST")).toBe("Mondays 8:30 AM");
    expect(shortSchedule("Weekdays at 7:00 AM EST", "HST")).toBe("Weekdays 7 AM EST");
    expect(shortSchedule("Monthly on the 1st at 9:00 AM UTC", "UTC")).toBe(
      "Monthly on the 1st 9 AM",
    );
  });
  test("names an event schedule by what it waits for", () => {
    expect(shortSchedule("On notifications matching mail.*")).toBe("On mail.* events");
    expect(shortSchedule("On notifications from gmail, matching mail.*")).toBe(
      "On gmail mail.* events",
    );
    expect(shortSchedule("On any routed notification")).toBe("On any event");
  });
  test("no schedule is on demand; intervals are already short", () => {
    expect(shortSchedule("Manual only")).toBe("On demand");
    expect(shortSchedule("Every 6 hours")).toBe("Every 6 hours");
  });
  test("a cron the server could not word reads as a custom schedule", () => {
    expect(shortSchedule("0 9 1 1,4,7,10 *")).toBe("Custom schedule");
    expect(shortSchedule("0 9 1 1,4,7,10 * HST")).toBe("Custom schedule");
  });
});
