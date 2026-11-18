import { describe, expect, test } from "bun:test";
import { stepsFor } from "../src/components/tour/OverviewTour";

describe("overview tour steps", () => {
  test("open with a welcome that asks, and end on the Ask box", () => {
    const steps = stepsFor(false);
    expect(steps[0]?.anchor).toBeNull();
    expect(steps.at(-1)?.anchor).toBe("ask");
  });

  test("stay short: four stops after the welcome", () => {
    expect(stepsFor(false).length).toBe(5);
  });

  test("leave out the sidebar's stops on a phone, where it is a closed drawer", () => {
    expect(stepsFor(true).map((s) => s.anchor)).toEqual([null, "chat", "ask"]);
  });
});
