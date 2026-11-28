/**
 * The end-to-end scenarios (`test/e2e/`) against this tree, booted in-process
 * with the suite's directive model: every scenario runs and passes, none
 * throws, and nothing is left behind.
 */

import { expect, test } from "bun:test";
import { SCENARIOS } from "../e2e/scenarios/index.ts";
import { inProcessTarget, isClean, runSuite } from "../e2e/suite.ts";

test("the end-to-end scenarios pass against this tree", async () => {
  const target = await inProcessTarget();
  try {
    const report = await runSuite({ target, scenarios: SCENARIOS });
    const failing = report.scenarios
      .filter((s) => s.status !== "pass")
      .map((s) => ({
        id: s.id,
        status: s.status,
        why: s.error ?? s.skipReason ?? s.checks.filter((c) => !c.ok),
      }));
    expect(failing).toEqual([]);
    expect(report.leftBehind).toEqual([]);
    expect(isClean(report)).toBe(true);
  } finally {
    await target.close();
  }
}, 180_000);
