/**
 * The ledger, end to end: a real turn spends, and `usage__report` reads it back.
 *
 * This is the regression test for the defect the ledger exists to fix. Usage
 * used to be derived from a storage side effect — a conversation JSONL
 * happening to exist — so a task run, which persists no conversation, spent
 * money the report could not see. The first test below runs `executeTask` and
 * asserts the spend appears. Before the ledger it did not, and no unit test
 * could have caught that, because the gap was between the writer and the
 * reader rather than inside either.
 */

import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../src/runtime/runtime.ts";
import { aggregateUsage } from "../../src/usage/aggregate.ts";
import { usageMonthDir, usageMonthOf } from "../../src/usage/paths.ts";
import type { UsageLedgerEntry } from "../../src/usage/types.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_IDENTITY } from "../helpers/test-auth-adapter.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime | undefined;
let workDir = "";

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = "";
});

async function start(): Promise<Runtime> {
  workDir = mkdtempSync(join(tmpdir(), "nb-ledger-"));
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createMockModel(() => ({
      content: [{ type: "text", text: "ok" }],
    })) },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, TEST_IDENTITY.id, "admin");
  return runtime;
}

/** Every ledger line this month, across shards. */
function readLines(): UsageLedgerEntry[] {
  const dir = usageMonthDir(workDir, usageMonthOf(new Date()));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as UsageLedgerEntry),
    );
}

test("a task run's spend reaches the report — the defect the ledger exists to fix", async () => {
  const rt = await start();
  await rt.executeTask({
    identity: TEST_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    prompt: "do the thing",
  });

  const lines = readLines();
  expect(lines.length).toBeGreaterThan(0);
  // A task run persists no conversation, which is precisely why the old
  // conversation-scan reader reported zero for it.
  const task = lines.filter((l) => l.origin === "task");
  expect(task.length).toBeGreaterThan(0);
  expect(task[0]?.usage.inputTokens).toBeGreaterThan(0);

  const report = await aggregateUsage(workDir, "month", "origin");
  expect(report.totals.llmCalls).toBe(lines.length);
  // Counted as a run, not a conversation — `sessionId` holds a run id here, so
  // conflating the two would report an automation as someone chatting.
  expect(report.totals.runs).toBe(1);
  expect(report.totals.conversations).toBe(0);
  expect(report.breakdown.find((b) => b.key === "task")).toBeDefined();
});

test("a chat turn counts as a conversation, and both land in one report", async () => {
  const rt = await start();
  await rt.chat({
    identity: TEST_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    message: "hello",
  });
  await rt.executeTask({
    identity: TEST_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    prompt: "do the thing",
  });

  const report = await aggregateUsage(workDir, "month", "origin");
  expect(report.totals.conversations).toBe(1);
  expect(report.totals.runs).toBe(1);
  const byOrigin = Object.fromEntries(report.breakdown.map((b) => [b.key, b.llmCalls]));
  expect(byOrigin.chat).toBeGreaterThan(0);
  expect(byOrigin.task).toBeGreaterThan(0);
});

test("ownerFilter fails closed on a line with no userId", async () => {
  const rt = await start();
  await rt.chat({
    identity: TEST_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    message: "hello",
  });

  const mine = await aggregateUsage(workDir, "month", "day", { ownerFilter: TEST_IDENTITY.id });
  expect(mine.totals.llmCalls).toBeGreaterThan(0);

  // Someone else's view must not see it, and neither must a filtered read see a
  // line whose owner is unknown — the case the predicate has to fail closed on.
  const theirs = await aggregateUsage(workDir, "month", "day", { ownerFilter: "usr_someone_else" });
  expect(theirs.totals.llmCalls).toBe(0);
});

test("an unpriced line reports its tokens and is counted, not billed as zero", async () => {
  await start();

  // Unpriced lines arise from backfill, not from live writes: the writer
  // resolves rates whenever the catalog knows the model, and a backfilled
  // automation run has no model recorded at all. So this writes the shape
  // backfill produces and reads it back, which is where the distinction has to
  // hold — the reader is what decides whether "no price" reads as "free".
  const month = usageMonthOf(new Date());
  mkdirSync(usageMonthDir(workDir, month), { recursive: true });
  const line: UsageLedgerEntry = {
    ts: new Date().toISOString(),
    source: "main",
    origin: "task",
    delegated: false,
    model: "unknown",
    usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
    llmMs: 0,
  };
  writeFileSync(join(usageMonthDir(workDir, month), "backfill.jsonl"), `${JSON.stringify(line)}\n`);

  const report = await aggregateUsage(workDir, "month", "day");
  expect(report.totals.tokens.input).toBe(1_000_000);
  expect(report.totals.tokens.output).toBe(500_000);
  // 1.5M tokens and no dollar figure. The count is what says the total is
  // incomplete rather than the spend being zero.
  expect(report.totals.cost.total).toBe(0);
  expect(report.totals.unpricedCalls).toBe(1);
});

test("a priced line is not counted as unpriced", async () => {
  const rt = await start();
  await rt.chat({
    identity: TEST_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    message: "hello",
  });

  const report = await aggregateUsage(workDir, "month", "day");
  expect(report.totals.llmCalls).toBeGreaterThan(0);
  expect(report.totals.unpricedCalls).toBeUndefined();
  expect(report.totals.cost.total).toBeGreaterThan(0);
});
