import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { log } from "../../../src/observability/log.ts";
import {
  noteRetiredToolName,
  resetRetiredToolNamesForTest,
} from "../../../src/tools/retired-tool-names.ts";

describe("noteRetiredToolName", () => {
  let info: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetRetiredToolNamesForTest();
    info = spyOn(log, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
  });

  it("logs a retired name once per caller and door, with the name to use", () => {
    noteRetiredToolName("automations__run", "usr_a", "route");
    noteRetiredToolName("automations__run", "usr_a", "route");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toEqual({
      tool: "automations__run",
      use: "tasks__run",
      caller: "usr_a",
      door: "route",
    });

    noteRetiredToolName("automations__run", "usr_b", "route");
    noteRetiredToolName("automations__run", "usr_a", "rest");
    noteRetiredToolName("automations__list", "usr_a", "route");
    expect(info).toHaveBeenCalledTimes(4);
  });

  it("says nothing for a current name", () => {
    noteRetiredToolName("tasks__run", "usr_a", "route");
    noteRetiredToolName("files__read", "usr_a", "rest");
    expect(info).not.toHaveBeenCalled();
  });
});
