import { describe, expect, test } from "bun:test";
import { stepsFor } from "../src/components/tour/OverviewTour";

describe("overview tour steps", () => {
  test("open with a welcome that asks, and end on the Ask box", () => {
    const steps = stepsFor(false);
    expect(steps[0]?.anchor).toBeNull();
    expect(steps.at(-1)?.anchor).toBe("ask");
  });

  test("stay short: five stops after the welcome, including where to install apps and add skills", () => {
    const anchors = stepsFor(false).map((s) => s.anchor);
    expect(anchors.length).toBe(6);
    expect(anchors).toContain("apps");
    expect(anchors).toContain("settings");
  });

  test("leave out the sidebar's stops on a phone, where it is a closed drawer", () => {
    expect(stepsFor(true).map((s) => s.anchor)).toEqual([null, "apps", "settings", "ask"]);
  });
});
