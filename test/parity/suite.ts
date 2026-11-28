/**
 * Run parity scenarios against a target and grade every inventory item they cover.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { bootParityRuntime, THIS_TREE } from "./boot.ts";
import { type Caller, ParityClient } from "./client.ts";
import { ALICE, BOB } from "./identities.ts";
import {
  type Capability,
  type CheckRecord,
  compact,
  Mismatch,
  type Scenario,
  type ScenarioContext,
} from "./scenario.ts";

// ── Targets ─────────────────────────────────────────────────────────────────

export interface Target {
  /** What the report calls this run, e.g. `in-process` or `main`. */
  label: string;
  kind: "in-process" | "tree" | "external";
  baseUrl: string;
  alice: Caller;
  bob?: Caller;
  /** A workspace to run in; absent: Alice's first workspace from bootstrap. */
  workspaceId?: string;
  catalogBase?: string;
  capabilities: ReadonlySet<Capability>;
  close(): Promise<void>;
}

const ALL: Capability[] = ["scripted-model", "second-identity", "org-admin", "fixture-catalog"];

const alice: Caller = { name: "alice", token: ALICE.token };
const bob: Caller = { name: "bob", token: BOB.token };

/** A runtime of this tree, in this process. */
export async function inProcessTarget(): Promise<Target> {
  const booted = await bootParityRuntime();
  return {
    label: "in-process",
    kind: "in-process",
    baseUrl: booted.baseUrl,
    alice,
    bob,
    catalogBase: booted.catalogBase,
    capabilities: new Set(ALL),
    close: () => booted.stop(),
  };
}

/** A runtime of another checkout (`root`), served by a child process. */
export async function treeTarget(root: string, label: string): Promise<Target> {
  const child = spawn("bun", ["--no-env-file", join(THIS_TREE, "test/parity/serve.ts"), root], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl !== -1) resolve(buffer.slice(0, nl));
    });
    child.on("exit", (code) => reject(new Error(`serve.ts exited (${code}) before listening`)));
  });
  const { baseUrl, catalogBase } = JSON.parse(line) as { baseUrl: string; catalogBase: string };
  return {
    label,
    kind: "tree",
    baseUrl,
    alice,
    bob,
    catalogBase,
    capabilities: new Set(ALL),
    close: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

/** A runtime someone else runs (a local `main`, staging), reached with tokens. */
export function externalTarget(env: Record<string, string | undefined>): Target {
  const baseUrl = env.PARITY_BASE_URL?.replace(/\/$/, "") ?? "";
  if (!env.PARITY_TOKEN) throw new Error("PARITY_TOKEN is required with PARITY_BASE_URL");
  const capabilities = new Set(
    (env.PARITY_CAPABILITIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is Capability => (ALL as string[]).includes(s)),
  );
  if (env.PARITY_TOKEN_B) capabilities.add("second-identity");
  else capabilities.delete("second-identity");
  return {
    label: env.PARITY_LABEL ?? new URL(baseUrl).host,
    kind: "external",
    baseUrl,
    alice: { name: "alice", token: env.PARITY_TOKEN },
    ...(env.PARITY_TOKEN_B ? { bob: { name: "bob", token: env.PARITY_TOKEN_B } } : {}),
    ...(env.PARITY_WORKSPACE ? { workspaceId: env.PARITY_WORKSPACE } : {}),
    ...(env.PARITY_CATALOG_BASE ? { catalogBase: env.PARITY_CATALOG_BASE } : {}),
    capabilities,
    close: async () => {},
  };
}

/** The target the environment names: an external URL, another tree, or this one in-process. */
export function targetFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<Target> {
  if (env.PARITY_BASE_URL) return Promise.resolve(externalTarget(env));
  if (env.PARITY_TREE) return treeTarget(env.PARITY_TREE, env.PARITY_LABEL ?? "tree");
  return inProcessTarget();
}

// ── The report ──────────────────────────────────────────────────────────────

export interface InventoryItem {
  id: string;
  area: string;
  item: string;
  status: string;
  use: string;
  harness: string;
}

export type ItemStatus = "pass" | "fail" | "skip" | "known-failure" | "fixed";

export interface ItemResult {
  status: ItemStatus;
  /** The inventory row: its engine status says whether a pass means "same" or "decided". */
  inventory: Pick<InventoryItem, "item" | "status" | "use" | "harness"> | null;
  scenarios: string[];
  checks: Array<Omit<CheckRecord, "ms">>;
  skipReason?: string;
  /** The baseline's finding for this item, when it is a known failure. */
  finding?: string;
}

export interface Report {
  target: { label: string; kind: string; baseUrl: string };
  startedAt: string;
  durationMs: number;
  summary: Record<ItemStatus, number>;
  scenarios: Array<{
    id: string;
    title: string;
    status: "ran" | "skipped" | "errored";
    ms: number;
    error?: string;
    notes?: Record<string, unknown>;
  }>;
  items: Record<string, ItemResult>;
}

export async function loadInventory(): Promise<Map<string, InventoryItem>> {
  const rows = (await Bun.file(join(import.meta.dir, "inventory.json")).json()) as InventoryItem[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** The known failures of this tree: item id → the finding, with its repro. */
export async function loadBaseline(): Promise<Record<string, string>> {
  return (await Bun.file(join(import.meta.dir, "expected-failures.json")).json()) as Record<
    string,
    string
  >;
}

// ── Running ─────────────────────────────────────────────────────────────────

export interface RunOptions {
  target: Target;
  scenarios: Scenario[];
  /** Apply the baseline: failures it lists are known, and an entry that passes is reported. */
  baseline?: Record<string, string>;
  log?: (line: string) => void;
}

async function firstWorkspace(client: ParityClient, caller: Caller): Promise<string> {
  const boot = await client.bootstrap(caller);
  const ws = boot.workspaces[0]?.id;
  if (!ws) throw new Error(`bootstrap gave ${caller.name} no workspace`);
  return ws;
}

export async function runSuite(opts: RunOptions): Promise<Report> {
  const { target, scenarios } = opts;
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const inventory = await loadInventory();
  const client = new ParityClient(target.baseUrl);
  const ws = target.workspaceId ?? (await firstWorkspace(client, target.alice));
  const second = target.capabilities.has("second-identity") ? target.bob : undefined;
  const bobWs = second ? await firstWorkspace(client, second) : undefined;

  const items: Record<string, ItemResult> = {};
  const item = (id: string): ItemResult => {
    let r = items[id];
    if (!r) {
      const inv = inventory.get(id);
      r = {
        status: "pass",
        inventory: inv
          ? { item: inv.item, status: inv.status, use: inv.use, harness: inv.harness }
          : null,
        scenarios: [],
        checks: [],
      };
      items[id] = r;
    }
    return r;
  };
  const scenarioRows: Report["scenarios"] = [];

  for (const scenario of scenarios) {
    const t0 = Date.now();
    for (const id of scenario.covers) item(id).scenarios.push(scenario.id);
    const missing = (scenario.requires ?? []).filter((c) => !target.capabilities.has(c));
    if (missing.length > 0) {
      for (const id of scenario.covers) {
        const r = item(id);
        if (r.checks.length === 0) {
          r.status = "skip";
          r.skipReason = `${scenario.id} needs ${missing.join(", ")}`;
        }
      }
      scenarioRows.push({ id: scenario.id, title: scenario.title, status: "skipped", ms: 0 });
      log(`- ${scenario.id}: skipped (needs ${missing.join(", ")})`);
      continue;
    }
    const checked = new Set<string>();
    const notes: Record<string, unknown> = {};
    const ctx: ScenarioContext = {
      client,
      alice: target.alice,
      ...(second ? { bob: second } : {}),
      ws,
      ...(bobWs ? { bobWs } : {}),
      ...(target.catalogBase ? { catalogBase: target.catalogBase } : {}),
      note: (key, value) => {
        notes[key] = compact(value, 400);
      },
      async check(ids, label, fn) {
        const list = Array.isArray(ids) ? ids : [ids];
        const c0 = Date.now();
        let ok = true;
        let evidence: unknown;
        try {
          evidence = compact(await fn());
        } catch (err) {
          ok = false;
          evidence =
            err instanceof Mismatch
              ? { error: err.message, seen: compact(err.seen) }
              : { error: err instanceof Error ? err.message : String(err) };
        }
        for (const id of list) {
          checked.add(id);
          const r = item(id);
          r.checks.push({ scenario: scenario.id, label, ok, evidence });
          if (!ok) r.status = "fail";
        }
        log(`  ${ok ? "ok  " : "FAIL"} [${list.join(",")}] ${label} (${Date.now() - c0}ms)`);
      },
    };
    log(`- ${scenario.id}: ${scenario.title}`);
    let error: string | undefined;
    try {
      await scenario.run(ctx);
    } catch (err) {
      error = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log(`  scenario error: ${error.split("\n")[0]}`);
    }
    for (const id of scenario.covers) {
      if (checked.has(id)) continue;
      const r = item(id);
      r.status = "fail";
      r.checks.push({
        scenario: scenario.id,
        label: "not reached",
        ok: false,
        evidence: error
          ? { error: error.split("\n").slice(0, 3).join(" ") }
          : "the scenario never checked it",
      });
    }
    scenarioRows.push({
      id: scenario.id,
      title: scenario.title,
      status: error ? "errored" : "ran",
      ms: Date.now() - t0,
      ...(error ? { error: error.split("\n").slice(0, 4).join("\n") } : {}),
      ...(Object.keys(notes).length > 0 ? { notes } : {}),
    });
  }

  if (opts.baseline) {
    for (const [id, finding] of Object.entries(opts.baseline)) {
      const r = items[id];
      if (!r) continue;
      if (r.status === "fail") {
        r.status = "known-failure";
        r.finding = finding;
      } else if (r.status === "pass") {
        r.status = "fixed";
        r.finding = finding;
      }
    }
  }

  const summary: Record<ItemStatus, number> = {
    pass: 0,
    fail: 0,
    skip: 0,
    "known-failure": 0,
    fixed: 0,
  };
  for (const r of Object.values(items)) summary[r.status]++;
  return {
    target: { label: target.label, kind: target.kind, baseUrl: target.baseUrl },
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    summary,
    scenarios: scenarioRows,
    items: Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Whether a graded run is clean: nothing failed outside the baseline, and no baseline entry passes. */
export function isClean(report: Report): boolean {
  return report.summary.fail === 0 && report.summary.fixed === 0;
}
