/**
 * How the parity suite (`test/parity/suite.ts`) grades a run: a baseline entry
 * excuses one check failing one way, and a scenario that throws fails the run.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Scenario } from "../parity/scenario.ts";
import { type BaselineEntry, isClean, runSuite, type Target } from "../parity/suite.ts";

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
    kind: "tree",
    baseUrl: `http://localhost:${server.port}`,
    alice: { name: "alice", token: "t" },
    capabilities: new Set(),
    close: async () => {},
  };
}

const ENTRY: BaselineEntry = {
  item: "TSK-07",
  scenario: "tasks.new-workspace",
  check: "the first run ends within 5 s",
  error: "ended within 5 s",
  finding: "a recorded finding",
};

function scenario(id: string, label: string, outcome: "pass" | Error, after?: Error): Scenario {
  return {
    id,
    title: id,
    covers: ["TSK-07"],
    async run(t) {
      await t.check("TSK-07", label, () => {
        if (outcome !== "pass") throw outcome;
        return "ok";
      });
      if (after) throw after;
    },
  };
}

const recorded = () => scenario("tasks.new-workspace", ENTRY.check, new Error("ended within 5 s"));

describe("the expected-failures baseline", () => {
  test("excuses its check failing as recorded", async () => {
    const report = await runSuite({ target: target(), scenarios: [recorded()], baseline: [ENTRY] });
    expect(report.items["TSK-07"]?.status).toBe("known-failure");
    expect(isClean(report)).toBe(true);
  });

  test("does not excuse another check failing on the same item", async () => {
    const report = await runSuite({
      target: target(),
      scenarios: [recorded(), scenario("tasks.runs", "run now ends", new Error("no run"))],
      baseline: [ENTRY],
    });
    expect(report.items["TSK-07"]?.status).toBe("fail");
    expect(isClean(report)).toBe(false);
  });

  test("does not excuse its check failing another way", async () => {
    const report = await runSuite({
      target: target(),
      scenarios: [scenario("tasks.new-workspace", ENTRY.check, new Error("create failed"))],
      baseline: [ENTRY],
    });
    expect(report.items["TSK-07"]?.status).toBe("fail");
    expect(isClean(report)).toBe(false);
  });

  test("reports its check passing as fixed", async () => {
    const report = await runSuite({
      target: target(),
      scenarios: [scenario("tasks.new-workspace", ENTRY.check, "pass")],
      baseline: [ENTRY],
    });
    expect(report.items["TSK-07"]?.status).toBe("fixed");
    expect(isClean(report)).toBe(false);
  });
});

test("a scenario that throws after its last check fails the run", async () => {
  const report = await runSuite({
    target: target(),
    scenarios: [scenario("tasks.runs", "run now ends", "pass", new Error("cleanup step threw"))],
  });
  expect(report.items["TSK-07"]?.status).toBe("pass");
  expect(report.scenarios[0]?.status).toBe("errored");
  expect(isClean(report)).toBe(false);
});
