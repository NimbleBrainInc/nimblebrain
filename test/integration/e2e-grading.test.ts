/**
 * How the end-to-end suite (`test/e2e/suite.ts`) grades a run: a failing
 * check fails its scenario and the run, a scenario that throws or checks
 * nothing fails the run, and `--smoke` selects only the smoke group.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Scenario } from "../e2e/scenario.ts";
import { SCENARIOS } from "../e2e/scenarios/index.ts";
import { isClean, runSuite, selectScenarios, type Target } from "../e2e/suite.ts";

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  // Only bootstrap is reached: the suite asks it for Alice's workspace.
  server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        user: { id: "usr_a", email: "a@example.test", displayName: "A", orgRole: "admin" },
        workspaces: [{ id: "ws_0000000000000001", name: "A" }],
      }),
  });
});
afterAll(() => server.stop(true));

function target(): Target {
  return {
    label: "stub",
    kind: "in-process",
    baseUrl: `http://localhost:${server.port}`,
    alice: { name: "alice", token: "t" },
    capabilities: new Set(),
    close: async () => {},
  };
}

function scenario(id: string, outcome: "pass" | Error, after?: Error): Scenario {
  return {
    id,
    title: id,
    async run(t) {
      await t.check("the step", () => {
        if (outcome !== "pass") throw outcome;
        return "ok";
      });
      if (after) throw after;
    },
  };
}

describe("grading", () => {
  test("a run whose checks all pass is clean", async () => {
    const report = await runSuite({ target: target(), scenarios: [scenario("a.pass", "pass")] });
    expect(report.scenarios[0]?.status).toBe("pass");
    expect(isClean(report)).toBe(true);
  });

  test("a failing check fails its scenario and the run", async () => {
    const report = await runSuite({
      target: target(),
      scenarios: [scenario("a.pass", "pass"), scenario("a.fail", new Error("no run"))],
    });
    expect(report.scenarios.map((s) => s.status)).toEqual(["pass", "fail"]);
    expect(isClean(report)).toBe(false);
  });

  test("a scenario that throws after its last check fails the run", async () => {
    const report = await runSuite({
      target: target(),
      scenarios: [scenario("a.throws", "pass", new Error("cleanup step threw"))],
    });
    expect(report.scenarios[0]?.status).toBe("errored");
    expect(isClean(report)).toBe(false);
  });

  test("a scenario that runs no check fails the run", async () => {
    const report = await runSuite({
      target: target(),
      scenarios: [{ id: "a.empty", title: "a.empty", run: async () => {} }],
    });
    expect(report.scenarios[0]?.status).toBe("fail");
    expect(isClean(report)).toBe(false);
  });

  test("a scenario the target cannot serve is skipped with the reason", async () => {
    const report = await runSuite({
      target: target(),
      scenarios: [{ ...scenario("a.needs", "pass"), requires: ["scripted-model"] }],
    });
    expect(report.scenarios[0]?.status).toBe("skip");
    expect(report.scenarios[0]?.skipReason).toBe("needs scripted-model");
  });

  test("a run that skips every scenario it selected fails", async () => {
    const report = await runSuite({
      target: target(),
      scenarios: [{ ...scenario("a.needs", "pass"), requires: ["scripted-model"] }],
    });
    expect(isClean(report)).toBe(false);
  });

  test("a run with a skip beside a pass is clean", async () => {
    const report = await runSuite({
      target: target(),
      scenarios: [
        scenario("a.pass", "pass"),
        { ...scenario("a.needs", "pass"), requires: ["scripted-model"] },
      ],
    });
    expect(isClean(report)).toBe(true);
  });
});

describe("selecting", () => {
  test("the smoke group is the scenarios tagged smoke", () => {
    const smoke = selectScenarios(SCENARIOS, { group: "smoke" });
    expect(smoke.length).toBeGreaterThan(0);
    expect(smoke.every((s) => s.groups?.includes("smoke"))).toBe(true);
    expect(smoke.length).toBe(SCENARIOS.filter((s) => s.groups?.includes("smoke")).length);
  });

  test("no filter selects every scenario; --only narrows by id prefix", () => {
    expect(selectScenarios(SCENARIOS)).toEqual(SCENARIOS);
    const chat = selectScenarios(SCENARIOS, { only: ["chat."] });
    expect(chat.length).toBeGreaterThan(0);
    expect(chat.every((s) => s.id.startsWith("chat."))).toBe(true);
  });

  test("the smoke scenarios run against any target: none needs the scripted model or a fixture", () => {
    const needs = selectScenarios(SCENARIOS, { group: "smoke" }).flatMap((s) => s.requires ?? []);
    expect(needs).toEqual([]);
  });
});
