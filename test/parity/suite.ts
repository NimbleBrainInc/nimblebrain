/**
 * Run parity scenarios against a target and grade every inventory item they cover.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { bootParityRuntime, THIS_TREE } from "./boot.ts";
import { type Caller, ParityClient, structured, textOf } from "./client.ts";
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

/**
 * A known failure of this tree: the one check it fails, and how. A failure of
 * any other check on the same item, or of this check in another way, is a
 * regression.
 */
export interface BaselineEntry {
  item: string;
  scenario: string;
  /** The check's label. */
  check: string;
  /** The error the failing check reports. */
  error: string;
  /** The finding, with its repro. */
  finding: string;
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
  /** Workspaces the run created and could not delete and purge, with why. */
  leftBehind: string[];
}

export async function loadInventory(): Promise<Map<string, InventoryItem>> {
  const rows = (await Bun.file(join(import.meta.dir, "inventory.json")).json()) as InventoryItem[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** The known failures of this tree. */
export async function loadBaseline(): Promise<BaselineEntry[]> {
  return (await Bun.file(
    join(import.meta.dir, "expected-failures.json"),
  ).json()) as BaselineEntry[];
}

function errorOf(evidence: unknown): unknown {
  return evidence && typeof evidence === "object" ? (evidence as { error?: unknown }).error : null;
}

/**
 * Grade items against the baseline: an item whose only failures are the
 * baseline's checks failing as recorded is a known failure; an item where a
 * baseline check passes is `fixed`; any other failure stays a failure.
 */
export function applyBaseline(items: Record<string, ItemResult>, baseline: BaselineEntry[]): void {
  for (const [id, r] of Object.entries(items)) {
    const entries = baseline.filter((e) => e.item === id);
    if (entries.length === 0) continue;
    const named = (e: BaselineEntry, c: ItemResult["checks"][number]) =>
      c.scenario === e.scenario && c.label === e.check;
    const failing = r.checks.filter((c) => !c.ok);
    const unexpected = failing.filter(
      (c) => !entries.some((e) => named(e, c) && errorOf(c.evidence) === e.error),
    );
    if (unexpected.length > 0) continue;
    const passing = entries.filter((e) => r.checks.some((c) => c.ok && named(e, c)));
    const known = entries.filter((e) => failing.some((c) => named(e, c)));
    if (passing.length > 0) {
      r.status = "fixed";
      r.finding = passing.map((e) => e.finding).join("\n");
    } else if (known.length > 0) {
      r.status = "known-failure";
      r.finding = known.map((e) => e.finding).join("\n");
    }
  }
}

// ── Running ─────────────────────────────────────────────────────────────────

export interface RunOptions {
  target: Target;
  scenarios: Scenario[];
  /** Apply the baseline: failures it lists are known, and an entry that passes is reported. */
  baseline?: BaselineEntry[];
  log?: (line: string) => void;
}

async function firstWorkspace(client: ParityClient, caller: Caller): Promise<string> {
  const boot = await client.bootstrap(caller);
  const ws = boot.workspaces[0]?.id;
  if (!ws) throw new Error(`bootstrap gave ${caller.name} no workspace`);
  return ws;
}

/** Create a workspace as the org admin; its id. */
async function createWorkspace(client: ParityClient, admin: Caller, name: string): Promise<string> {
  const r = await client.identityTool(admin, "nb__manage_workspaces", { action: "create", name });
  const out = structured<{ id?: string; workspace?: { id: string } }>(r);
  const ws = out.workspace?.id ?? out.id;
  if (r.isError || !ws) throw new Error(`creating ${name} failed: ${textOf(r).slice(0, 300)}`);
  return ws;
}

/** Delete and purge `ws`; why it is still there, or undefined when it is gone. */
async function disposeWorkspace(
  client: ParityClient,
  admin: Caller,
  ws: string,
): Promise<string | undefined> {
  const manage = (args: Record<string, unknown>) =>
    client.identityTool(admin, "nb__manage_workspaces", args);
  try {
    await manage({ action: "delete", workspaceId: ws });
    const purged = await manage({ action: "purge", workspaceId: ws });
    if (!purged.isError) return undefined;
    // A scenario that purged it already leaves nothing to purge.
    const live = JSON.stringify(structured(await manage({ action: "list" })));
    const deleted = JSON.stringify(structured(await manage({ action: "list_deleted" })));
    if (!live.includes(ws) && !deleted.includes(ws)) return undefined;
    return `${ws}: purge refused: ${textOf(purged).slice(0, 200)}`;
  } catch (err) {
    return `${ws}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Why a deployment run skips every scenario without org-admin. */
const ISOLATION = "org-admin, to write only in workspaces the suite creates";

export async function runSuite(opts: RunOptions): Promise<Report> {
  const { target, scenarios } = opts;
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const inventory = await loadInventory();
  const client = new ParityClient(target.baseUrl);
  const second = target.capabilities.has("second-identity") ? target.bob : undefined;
  // A deployment's workspaces are real: every scenario writes, so there it runs
  // only in workspaces this run creates, and deletes and purges in the end.
  const external = target.kind === "external";
  const isolated = !external || target.capabilities.has("org-admin");
  const leftBehind: string[] = [];
  const runOwned: string[] = [];
  const dispose = async (list: string[]) => {
    for (const id of list.splice(0)) {
      const why = await disposeWorkspace(client, target.alice, id);
      if (why) {
        leftBehind.push(why);
        log(`  LEFT BEHIND ${why}`);
      }
    }
  };

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

  try {
    let ws = "";
    let bobWs: string | undefined;
    if (external && isolated) {
      const stamp = Date.now().toString(36);
      ws = await createWorkspace(client, target.alice, `Parity run ${stamp}`);
      runOwned.push(ws);
      if (second) {
        // Bob's own workspace, which Alice leaves once Bob is its admin.
        bobWs = await createWorkspace(client, target.alice, `Parity run ${stamp} (second)`);
        runOwned.push(bobWs);
        const bobId = (await client.bootstrap(second)).user.id;
        const aliceId = (await client.bootstrap(target.alice)).user.id;
        for (const args of [
          { action: "add_member", userId: bobId, role: "admin" },
          { action: "remove_member", userId: aliceId },
        ]) {
          const r = await client.identityTool(target.alice, "nb__manage_workspaces", {
            ...args,
            workspaceId: bobWs,
          });
          if (r.isError) throw new Error(`${args.action} failed: ${textOf(r).slice(0, 300)}`);
        }
      }
    } else if (!external) {
      ws = await firstWorkspace(client, target.alice);
      bobWs = second ? await firstWorkspace(client, second) : undefined;
    }

    for (const scenario of scenarios) {
      const t0 = Date.now();
      for (const id of scenario.covers) item(id).scenarios.push(scenario.id);
      const missing: string[] = isolated
        ? (scenario.requires ?? []).filter((c) => !target.capabilities.has(c))
        : [ISOLATION];
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
      const owned: string[] = [];
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
        disposable: (id) => {
          owned.push(id);
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
      } finally {
        await dispose(owned);
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
  } finally {
    await dispose(runOwned);
  }

  if (opts.baseline) applyBaseline(items, opts.baseline);

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
    leftBehind,
  };
}

/**
 * Whether a graded run is clean: nothing failed outside the baseline, no
 * baseline entry passes, no scenario threw, and nothing the run created is left.
 */
export function isClean(report: Report): boolean {
  return (
    report.summary.fail === 0 &&
    report.summary.fixed === 0 &&
    report.scenarios.every((s) => s.status !== "errored") &&
    report.leftBehind.length === 0
  );
}
