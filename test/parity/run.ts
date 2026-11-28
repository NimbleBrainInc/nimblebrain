/**
 * The parity suite's command line.
 *
 *   bun run test:parity                       this tree, in-process, graded against the baseline
 *   PARITY_TREE=/path/to/main bun run test:parity      another checkout, served by a child process
 *   PARITY_BASE_URL=https://… PARITY_TOKEN=… bun run test:parity   a running deployment
 *   bun run test:parity diff a.json b.json    the items whose status differs between two reports
 *
 * `PARITY_ONLY=chat,files` runs those scenarios (by id prefix). `PARITY_REPORT`
 * names the report file (default `.cache/parity/<label>.json`).
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { THIS_TREE } from "./boot.ts";
import { SCENARIOS } from "./scenarios/index.ts";
import { isClean, loadBaseline, type Report, runSuite, targetFromEnv } from "./suite.ts";

const env = process.env;

async function diff(aPath: string, bPath: string): Promise<number> {
  const a = (await Bun.file(aPath).json()) as Report;
  const b = (await Bun.file(bPath).json()) as Report;
  const ids = [...new Set([...Object.keys(a.items), ...Object.keys(b.items)])].sort();
  let differing = 0;
  console.log(`item\t${a.target.label}\t${b.target.label}\tinventory`);
  for (const id of ids) {
    const sa = a.items[id]?.status ?? "-";
    const sb = b.items[id]?.status ?? "-";
    if (sa === sb) continue;
    differing++;
    console.log(
      `${id}\t${sa}\t${sb}\t${a.items[id]?.inventory?.status ?? b.items[id]?.inventory?.status ?? ""}`,
    );
  }
  console.log(`${differing} of ${ids.length} items differ`);
  return 0;
}

async function run(): Promise<number> {
  const only = env.PARITY_ONLY?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const scenarios = only
    ? SCENARIOS.filter((s) => only.some((p) => s.id.startsWith(p)))
    : SCENARIOS;
  const target = await targetFromEnv(env);
  // The baseline records this tree's known findings, so it grades this tree only.
  const graded = target.kind === "in-process" || env.PARITY_BASELINE === "1";
  let report: Report;
  try {
    report = await runSuite({
      target,
      scenarios,
      ...(graded ? { baseline: await loadBaseline() } : {}),
      log: (line) => console.log(line),
    });
  } finally {
    await target.close();
  }
  const out = env.PARITY_REPORT ?? join(THIS_TREE, ".cache/parity", `${report.target.label}.json`);
  mkdirSync(dirname(out), { recursive: true });
  await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
  const s = report.summary;
  console.log(
    `\n${report.target.label}: ${s.pass} pass, ${s.fail} fail, ${s["known-failure"]} known failure, ${s.fixed} fixed (in the baseline but passing), ${s.skip} skipped — ${Object.keys(report.items).length} items in ${(report.durationMs / 1000).toFixed(1)}s`,
  );
  for (const [id, r] of Object.entries(report.items)) {
    if (r.status === "fail" || r.status === "fixed") {
      const bad = r.checks.find((c) => !c.ok);
      console.log(
        `  ${r.status.toUpperCase()} ${id}: ${bad ? `${bad.label} — ${JSON.stringify(bad.evidence)}` : r.finding}`,
      );
    }
  }
  console.log(`report: ${out}`);
  if (!graded && env.PARITY_STRICT !== "1") return 0;
  return isClean(report) ? 0 : 1;
}

const [command, ...rest] = process.argv.slice(2);
const code = command === "diff" && rest[0] && rest[1] ? await diff(rest[0], rest[1]) : await run();
process.exit(code);
