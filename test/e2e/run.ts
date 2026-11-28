/**
 * The end-to-end suite's command line.
 *
 *   bun run test:e2e                     every scenario, against this tree booted in-process
 *   bun run test:e2e --smoke             only the smoke group
 *   E2E_BASE_URL=https://… E2E_TOKEN=… E2E_CAPABILITIES=org-admin bun run test:e2e --smoke
 *                                        a running deployment, after it deploys
 *
 * `--only chat,files` (or `E2E_ONLY`) runs the scenarios whose id starts with
 * one of those prefixes. `E2E_REPORT` names the report file (default
 * `.cache/e2e/<label>.json`). The exit code is non-zero when a scenario fails
 * or throws, the run leaves something behind, or no scenario passes; a
 * prefix that selects nothing exits non-zero before the run starts.
 * `E2E_EXPECT_CATALOG=1` states that the deployment's Browse lists items.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { THIS_TREE } from "./boot.ts";
import type { Scenario } from "./scenario.ts";
import { SCENARIOS } from "./scenarios/index.ts";
import { isClean, type Report, runSuite, selectScenarios, targetFromEnv } from "./suite.ts";

const env = process.env;
const args = process.argv.slice(2);

function onlyPrefixes(): string[] | undefined {
  const at = args.indexOf("--only");
  const raw = at !== -1 ? args[at + 1] : env.E2E_ONLY;
  return raw
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<number> {
  const only = onlyPrefixes();
  let scenarios: Scenario[];
  try {
    scenarios = selectScenarios(SCENARIOS, {
      ...(args.includes("--smoke") ? { group: "smoke" as const } : {}),
      ...(only ? { only } : {}),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const target = await targetFromEnv(env);
  let report: Report;
  try {
    report = await runSuite({ target, scenarios, log: (line) => console.log(line) });
  } finally {
    await target.close();
  }
  const out = env.E2E_REPORT ?? join(THIS_TREE, ".cache/e2e", `${report.target.label}.json`);
  mkdirSync(dirname(out), { recursive: true });
  await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
  const s = report.summary;
  console.log(
    `\n${report.target.label}: ${s.pass} pass, ${s.fail} fail, ${s.errored} errored, ${s.skip} skipped — ${report.scenarios.length} scenarios in ${(report.durationMs / 1000).toFixed(1)}s`,
  );
  for (const r of report.scenarios) {
    if (r.status === "fail") {
      for (const c of r.checks.filter((c) => !c.ok)) {
        console.log(`  FAIL ${r.id}: ${c.label} — ${JSON.stringify(c.evidence)}`);
      }
    } else if (r.status === "errored") {
      console.log(`  ERRORED ${r.id}: ${r.error?.split("\n")[0]}`);
    } else if (r.status === "skip") {
      console.log(`  SKIP ${r.id}: ${r.skipReason}`);
    }
  }
  for (const why of report.leftBehind) console.log(`  LEFT BEHIND ${why}`);
  console.log(`report: ${out}`);
  return isClean(report) ? 0 : 1;
}

process.exit(await main());
