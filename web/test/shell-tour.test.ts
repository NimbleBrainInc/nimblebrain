import { describe, expect, test } from "bun:test";
import { ACTIONS, EVENTS, STATUS } from "react-joyride";
import { nextMove, stepsFor } from "../src/components/tour/ShellTour";

describe("shell tour steps", () => {
  test("open with a welcome that asks, and end on the Ask box", () => {
    const steps = stepsFor(false);
    expect(steps[0]?.anchor).toBeNull();
    expect(steps.at(-1)?.anchor).toBe("ask");
  });

  test("stay short: five stops after the welcome, opening the catalog and Skills pages", () => {
    const steps = stepsFor(false);
    expect(steps.length).toBe(6);
    expect(steps.find((s) => s.anchor === "catalog")?.page).toBe("catalog");
    expect(steps.find((s) => s.anchor === "skills")?.page).toBe("skills");
  });

  test("return to Overview before the last step", () => {
    expect(stepsFor(false).at(-1)?.page).toBe("overview");
  });

  test("leave out the sidebar's stops on a phone, where it is a closed drawer", () => {
    expect(stepsFor(true).map((s) => s.anchor)).toEqual([null, "apps", "catalog", "skills", "ask"]);
  });
});

describe("moving through the controlled tour", () => {
  const ev = (over: Partial<Parameters<typeof nextMove>[0]>) => ({
    status: STATUS.RUNNING,
    type: EVENTS.STEP_AFTER,
    action: ACTIONS.NEXT,
    index: 0,
    ...over,
  });

  test("Next and Back move one step", () => {
    expect(nextMove(ev({ index: 2 }), 6)).toEqual({ kind: "go", to: 3 });
    expect(nextMove(ev({ index: 2, action: ACTIONS.PREV }), 6)).toEqual({ kind: "go", to: 1 });
  });

  test("Next past the last step finishes the tour", () => {
    expect(nextMove(ev({ index: 5 }), 6)).toEqual({ kind: "end", how: "finished" });
  });

  test("a step whose anchor never rendered is passed over", () => {
    expect(nextMove(ev({ index: 3, type: EVENTS.TARGET_NOT_FOUND }), 6)).toEqual({
      kind: "go",
      to: 4,
    });
  });

  test("Skip ends it; other events change nothing", () => {
    expect(nextMove(ev({ status: STATUS.SKIPPED }), 6)).toEqual({ kind: "end", how: "skipped" });
    expect(nextMove(ev({ type: EVENTS.TOOLTIP }), 6)).toEqual({ kind: "stay" });
  });
});
