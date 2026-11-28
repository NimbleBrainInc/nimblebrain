/**
 * The parity scenarios (`test/parity/`) against this tree, booted in-process
 * with the suite's directive model: every inventory item they cover passes,
 * but for the known findings in `expected-failures.json`, and none of those
 * passes unnoticed.
 */

import { expect, test } from "bun:test";
import { SCENARIOS } from "../parity/scenarios/index.ts";
import { inProcessTarget, loadBaseline, runSuite } from "../parity/suite.ts";

test("the parity scenarios pass against this tree, but for their baseline", async () => {
  const target = await inProcessTarget();
  try {
    const report = await runSuite({ target, scenarios: SCENARIOS, baseline: await loadBaseline() });
    const unexpected = Object.entries(report.items)
      .filter(([, r]) => r.status === "fail" || r.status === "fixed")
      .map(([id, r]) => ({
        id,
        status: r.status,
        check: r.checks.find((c) => !c.ok) ?? r.finding,
      }));
    expect(unexpected).toEqual([]);
    expect(report.summary.skip).toBe(0);
  } finally {
    await target.close();
  }
}, 120_000);
