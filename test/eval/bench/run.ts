/**
 * Agent bench: each case, on each model, several times, on a fresh runtime.
 *
 * A run is graded on what it stored and how it got there, not on its reply:
 *   - goal: the case's checks against the workspace's files and tasks
 *   - tools: required calls made, forbidden calls avoided, no duplicates past a case's limit
 *   - honest: on a missed goal, whether the last reply admitted it (a reply
 *     with no admission is a silent failure: the agent said it was done)
 *   - cost: input and output tokens, USD, wall time, model iterations, tool calls
 *
 * Run:
 *   bun run eval:bench                        quick preset: one model per provider with a key set
 *   NB_BENCH_PRESET=full bun run eval:bench   the providers' main tiers plus local models (models.ts)
 *   NB_BENCH_MODELS=local:gemma4:e4b bun --no-env-file test/eval/bench/run.ts
 *   NB_BENCH_MODELS=anthropic:claude-sonnet-4-6,local:qwen3:8b ANTHROPIC_API_KEY=… \
 *     NB_BENCH_RUNS=3 NB_BENCH_CASES=task-lifecycle bun --no-env-file test/eval/bench/run.ts
 *
 * `local:<id>` reaches an OpenAI Chat Completions server at NB_LOCAL_MODEL_URL
 * (default Ollama, http://127.0.0.1:11434/v1) with a 32k window, as
 * `npx nimblebrain --local-model` sets one up. Results go to NB_BENCH_OUT
 * (default a temp dir) as runs.json and summary.md.
 *
 * Calls real models. Not in `bun run test` or `verify`.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { loadAllTasks, readRuns } from "../../../src/platform/tasks/store.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import type { ChatResult, RuntimeConfig } from "../../../src/runtime/types.ts";
import { devProvider, devWorkspace } from "../../helpers/dev-provider.ts";
import { type BenchCase, CASES, type RunState, type ToolExpectations } from "./cases.ts";
import { KEY_ENV, PRESETS } from "./models.ts";

const env = process.env;
const PRESET = env.NB_BENCH_PRESET ?? "quick";
const LISTED = env.NB_BENCH_MODELS?.split(",").map((m) => m.trim());
if (!LISTED && !PRESETS[PRESET]) throw new Error(`unknown NB_BENCH_PRESET ${PRESET}: use quick or full`);
const REQUESTED = LISTED ?? PRESETS[PRESET] ?? [];
/** A model runs when its provider's key is set; local needs none. */
const hasKey = (m: string) => {
  const name = KEY_ENV[m.split(":")[0] ?? ""];
  return name === undefined || !!env[name];
};
const MODELS = REQUESTED.filter(hasKey);
const SKIPPED = REQUESTED.filter((m) => !hasKey(m));
const RUNS = Number(env.NB_BENCH_RUNS ?? 3);
const ONLY = env.NB_BENCH_CASES?.split(",").map((c) => c.trim());
const LOCAL_URL = env.NB_LOCAL_MODEL_URL ?? "http://127.0.0.1:11434/v1";
const MAX_ITERATIONS = 15;
const OUT = env.NB_BENCH_OUT ?? join(tmpdir(), `nimblebrain-bench-${Date.now()}`);

/** Words a reply uses when it admits the work did not get done. */
const ADMITS =
  /\b(couldn'?t|could not|can'?t|cannot|unable|wasn'?t able|not able|failed|error|didn'?t|did not|sorry|unfortunately)\b/i;

interface RunRecord {
  model: string;
  caseId: string;
  run: number;
  goal: boolean;
  goalFailures: string[];
  toolFailures: string[];
  /** Missed the goal and the last reply did not say so. */
  silentFailure: boolean;
  toolCalls: string[];
  failedCalls: number;
  /** Same tool with the same input called more than once. */
  repeatedCalls: number;
  /** Every call in order: its tool, whether it succeeded, its input, and the start of its output. */
  /** Each turn's reply, in order. */
  replies: string[];
  trace: Array<{ turn: number; name: string; ok: boolean; input: Record<string, unknown>; output: string }>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  iterations: number;
  wallMs: number;
  lastReply: string;
  error?: string;
}

function providersFor(model: string): RuntimeConfig["providers"] {
  const [provider = "", ...rest] = model.split(":");
  const id = rest.join(":");
  if (provider === "local") {
    return { local: { baseURL: LOCAL_URL, models: [id], contextWindow: 32_768 } };
  }
  const keyName = KEY_ENV[provider];
  const apiKey = keyName ? env[keyName] : undefined;
  if (!apiKey) throw new Error(`${model} needs ${keyName ?? "a known provider"}`);
  // The model list holds the one model under test, so the run cannot fall back to another.
  return { [provider]: { apiKey, models: [id] } };
}

function scoreTools(turns: ChatResult[], expect: ToolExpectations): string[] {
  const names = turns.flatMap((t) => t.toolCalls.map((c) => c.name));
  const count = (n: string) => names.filter((x) => x === n).length;
  const errs: string[] = [];
  for (const n of expect.required ?? []) if (count(n) === 0) errs.push(`never called ${n}`);
  for (const n of expect.forbidden ?? []) if (count(n) > 0) errs.push(`called ${n}`);
  for (const [n, max] of Object.entries(expect.maxCalls ?? {})) {
    if (count(n) > max) errs.push(`called ${n} ${count(n)}x (max ${max})`);
  }
  return errs;
}

function repeated(turns: ChatResult[]): number {
  const seen = new Set<string>();
  let dupes = 0;
  for (const c of turns.flatMap((t) => t.toolCalls)) {
    const key = `${c.name}:${JSON.stringify(c.input)}`;
    if (seen.has(key)) dupes++;
    seen.add(key);
  }
  return dupes;
}

async function readState(runtime: Runtime, workDir: string, wsId: string, turns: ChatResult[]) {
  const store = runtime.getWorkspaceFileStore(wsId, DEV_IDENTITY.id);
  const files: RunState["files"] = [];
  for (const entry of await store.readRegistry().catch(() => [])) {
    const read = await store.readFile(entry.id).catch(() => null);
    if (read) files.push({ filename: read.filename, text: read.data.toString("utf8") });
  }
  const tasks = loadAllTasks(workDir).map((task) => ({
    task,
    runs: readRuns(workDir, wsId, DEV_IDENTITY.id, task.id),
  }));
  return { turns, files, tasks } satisfies RunState;
}

async function runOnce(model: string, c: BenchCase, run: number): Promise<RunRecord> {
  const workDir = join(tmpdir(), `nb-bench-${c.id}-${run}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const base = { model, caseId: c.id, run };
  const started = Date.now();
  let runtime: Runtime | null = null;
  const turns: ChatResult[] = [];
  try {
    runtime = await Runtime.start({
      identityProvider: devProvider,
      providers: providersFor(model),
      models: { default: model, fast: model },
      workDir,
      maxIterations: MAX_ITERATIONS,
      telemetry: { enabled: false },
      logging: { disabled: true },
    });
    const wsId = await devWorkspace(runtime);
    let conversationId: string | undefined;
    for (const message of c.turns) {
      const r = await runtime.chat({
        message,
        identity: DEV_IDENTITY,
        workspaceId: wsId,
        conversationId,
      });
      conversationId = r.conversationId;
      turns.push(r);
    }
    const state = await readState(runtime, workDir, wsId, turns);
    const goalFailures = c.check(state);
    const lastReply = turns[turns.length - 1]?.response ?? "";
    const calls = turns.flatMap((t) => t.toolCalls);
    return {
      ...base,
      goal: goalFailures.length === 0,
      goalFailures,
      toolFailures: scoreTools(turns, c.tools),
      silentFailure: goalFailures.length > 0 && !ADMITS.test(lastReply),
      toolCalls: calls.map((t) => (t.ok ? t.name : `${t.name}!`)),
      failedCalls: calls.filter((t) => !t.ok).length,
      repeatedCalls: repeated(turns),
      replies: turns.map((t) => t.response.slice(0, 300)),
      trace: turns.flatMap((t, i) =>
        t.toolCalls.map((c) => ({ turn: i + 1, name: c.name, ok: c.ok, input: c.input, output: c.output.slice(0, 300) })),
      ),
      inputTokens: turns.reduce((s, t) => s + t.usage.inputTokens, 0),
      outputTokens: turns.reduce((s, t) => s + t.usage.outputTokens, 0),
      costUsd: turns.reduce((s, t) => s + t.costUsd, 0),
      iterations: turns.reduce((s, t) => s + t.usage.iterations, 0),
      wallMs: Date.now() - started,
      lastReply: lastReply.slice(0, 400),
    };
  } catch (err) {
    return {
      ...base,
      goal: false,
      goalFailures: ["run errored"],
      toolFailures: [],
      silentFailure: false,
      toolCalls: turns.flatMap((t) => t.toolCalls.map((c) => c.name)),
      failedCalls: 0,
      repeatedCalls: 0,
      replies: [],
      trace: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      iterations: 0,
      wallMs: Date.now() - started,
      lastReply: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await runtime?.shutdown().catch(() => {});
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function summarize(records: RunRecord[]): string {
  const rows = [
    "| Model | Case | Goal | pass^k | Tools clean | Silent fail | Tokens in / out | Cost | Wall s | Calls (failed) |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const model of MODELS) {
    for (const c of CASES.filter((x) => !ONLY || ONLY.includes(x.id))) {
      const rs = records.filter((r) => r.model === model && r.caseId === c.id);
      if (!rs.length) continue;
      const goals = rs.filter((r) => r.goal).length;
      rows.push(
        `| ${model} | ${c.id} | ${goals}/${rs.length} | ${goals === rs.length ? "yes" : "no"} | ` +
          `${rs.filter((r) => r.toolFailures.length === 0).length}/${rs.length} | ` +
          `${rs.filter((r) => r.silentFailure).length} | ` +
          `${Math.round(mean(rs.map((r) => r.inputTokens)))} / ${Math.round(mean(rs.map((r) => r.outputTokens)))} | ` +
          `$${mean(rs.map((r) => r.costUsd)).toFixed(4)} | ${(mean(rs.map((r) => r.wallMs)) / 1000).toFixed(1)} | ` +
          `${mean(rs.map((r) => r.toolCalls.length)).toFixed(1)} (${mean(rs.map((r) => r.failedCalls)).toFixed(1)}) |`,
      );
    }
  }
  const misses = records
    .filter((r) => !r.goal || r.toolFailures.length)
    .map(
      (r) =>
        `- ${r.model} ${r.caseId} #${r.run}: ${[...r.goalFailures, ...r.toolFailures, r.error ?? ""].filter(Boolean).join("; ")}` +
        ` — calls: ${r.toolCalls.join(" → ") || "none"}`,
    );
  const skipped = SKIPPED.length ? `\nSkipped (no key): ${SKIPPED.join(", ")}\n` : "";
  return `${rows.join("\n")}\n${skipped}\nMeans per run. Silent fail: goal missed and the last reply did not admit it.\n\n## Misses\n\n${misses.join("\n") || "none"}\n`;
}

const records: RunRecord[] = [];
for (const m of SKIPPED) process.stdout.write(`${m}: skipped, no ${KEY_ENV[m.split(":")[0] ?? ""]}\n`);
for (const model of MODELS) {
  for (const c of CASES.filter((x) => !ONLY || ONLY.includes(x.id))) {
    for (let i = 1; i <= RUNS; i++) {
      const r = await runOnce(model, c, i);
      records.push(r);
      process.stdout.write(
        `${model} ${c.id} #${i}: ${r.goal ? "goal" : "MISS"}${r.silentFailure ? " (silent)" : ""} ` +
          `${(r.wallMs / 1000).toFixed(1)}s ${r.error ? `error: ${r.error}` : ""}\n`,
      );
    }
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "runs.json"), JSON.stringify(records, null, 2));
const summary = summarize(records);
writeFileSync(join(OUT, "summary.md"), summary);
process.stdout.write(`\n${summary}\nResults: ${OUT}\n`);
// A shut-down runtime's pollers can still hold the event loop open.
process.exit(0);
