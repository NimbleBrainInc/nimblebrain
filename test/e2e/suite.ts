/**
 * Run end-to-end scenarios against a target and report each one's checks.
 */

import { bootRuntime } from "./boot.ts";
import { type Caller, E2EClient, structured, textOf } from "./client.ts";
import { ALICE, BOB } from "./identities.ts";
import {
  type Capability,
  type CheckRecord,
  compact,
  type Group,
  Mismatch,
  type Scenario,
  type ScenarioContext,
} from "./scenario.ts";

// ── Targets ─────────────────────────────────────────────────────────────────

export interface Target {
  /** What the report calls this run, e.g. `in-process` or a deployment's host. */
  label: string;
  /** `in-process`: this tree, booted by the suite. `deployment`: a runtime someone else runs. */
  kind: "in-process" | "deployment";
  baseUrl: string;
  alice: Caller;
  bob?: Caller;
  catalogBase?: string;
  capabilities: ReadonlySet<Capability>;
  close(): Promise<void>;
}

const ALL: Capability[] = ["scripted-model", "second-identity", "org-admin", "fixture-catalog"];

/** This tree, booted in this process with the directive model, two people and the fixture catalog. */
export async function inProcessTarget(): Promise<Target> {
  const booted = await bootRuntime();
  return {
    label: "in-process",
    kind: "in-process",
    baseUrl: booted.baseUrl,
    alice: { name: "alice", token: ALICE.token },
    bob: { name: "bob", token: BOB.token },
    catalogBase: booted.catalogBase,
    capabilities: new Set(ALL),
    close: () => booted.stop(),
  };
}

/** A running deployment, reached at `E2E_BASE_URL` with the people's tokens. */
export function deploymentTarget(env: Record<string, string | undefined>): Target {
  const baseUrl = env.E2E_BASE_URL?.replace(/\/$/, "") ?? "";
  if (!env.E2E_TOKEN) throw new Error("E2E_TOKEN is required with E2E_BASE_URL");
  const capabilities = new Set(
    (env.E2E_CAPABILITIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is Capability => (ALL as string[]).includes(s)),
  );
  if (env.E2E_TOKEN_B) capabilities.add("second-identity");
  else capabilities.delete("second-identity");
  return {
    label: env.E2E_LABEL ?? new URL(baseUrl).host,
    kind: "deployment",
    baseUrl,
    alice: { name: "alice", token: env.E2E_TOKEN },
    ...(env.E2E_TOKEN_B ? { bob: { name: "bob", token: env.E2E_TOKEN_B } } : {}),
    ...(env.E2E_CATALOG_BASE ? { catalogBase: env.E2E_CATALOG_BASE } : {}),
    capabilities,
    close: async () => {},
  };
}

/** The target the environment names: a deployment at `E2E_BASE_URL`, else this tree in-process. */
export function targetFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<Target> {
  if (env.E2E_BASE_URL) return Promise.resolve(deploymentTarget(env));
  return inProcessTarget();
}

// ── Selecting ───────────────────────────────────────────────────────────────

/**
 * The scenarios a run takes: those in `group` when one is named, then those
 * whose id starts with one of `only`'s prefixes when given. No filter: all.
 */
export function selectScenarios(
  all: Scenario[],
  opts: { group?: Group; only?: string[] } = {},
): Scenario[] {
  return all.filter(
    (s) =>
      (!opts.group || (s.groups ?? []).includes(opts.group)) &&
      (!opts.only?.length || opts.only.some((p) => s.id.startsWith(p))),
  );
}

// ── The report ──────────────────────────────────────────────────────────────

/**
 * `pass`: it ran checks and every one passed. `fail`: a check failed, or it
 * ran none. `errored`: it threw. `skip`: the target lacks what it requires.
 */
export type ScenarioStatus = "pass" | "fail" | "errored" | "skip";

export interface ScenarioResult {
  id: string;
  title: string;
  groups: Group[];
  status: ScenarioStatus;
  ms: number;
  checks: Array<Omit<CheckRecord, "ms">>;
  skipReason?: string;
  error?: string;
  notes?: Record<string, unknown>;
}

export interface Report {
  target: { label: string; kind: string; baseUrl: string };
  startedAt: string;
  durationMs: number;
  summary: Record<ScenarioStatus, number>;
  scenarios: ScenarioResult[];
  /** Workspaces the run created and could not delete and purge, with why. */
  leftBehind: string[];
}

/**
 * A run passes when no scenario failed or threw, nothing the run created is
 * left, and something ran: a run that skips every scenario it selected (a
 * deployment token without org-admin) proves nothing.
 */
export function isClean(report: Report): boolean {
  const { fail, errored, skip } = report.summary;
  const allSkipped = report.scenarios.length > 0 && skip === report.scenarios.length;
  return fail === 0 && errored === 0 && report.leftBehind.length === 0 && !allSkipped;
}

// ── Running ─────────────────────────────────────────────────────────────────

export interface RunOptions {
  target: Target;
  scenarios: Scenario[];
  log?: (line: string) => void;
}

async function firstWorkspace(client: E2EClient, caller: Caller): Promise<string> {
  const boot = await client.bootstrap(caller);
  const ws = boot.workspaces[0]?.id;
  if (!ws) throw new Error(`bootstrap gave ${caller.name} no workspace`);
  return ws;
}

/** Create a workspace as the org admin; its id. */
async function createWorkspace(client: E2EClient, admin: Caller, name: string): Promise<string> {
  const r = await client.identityTool(admin, "nb__manage_workspaces", { action: "create", name });
  const out = structured<{ id?: string; workspace?: { id: string } }>(r);
  const ws = out.workspace?.id ?? out.id;
  if (r.isError || !ws) throw new Error(`creating ${name} failed: ${textOf(r).slice(0, 300)}`);
  return ws;
}

/** Delete and purge `ws`; why it is still there, or undefined when it is gone. */
async function disposeWorkspace(
  client: E2EClient,
  admin: Caller,
  ws: string,
): Promise<string | undefined> {
  const manage = (args: Record<string, unknown>) =>
    client.identityTool(admin, "nb__manage_workspaces", args);
  try {
    await manage({ action: "delete", workspaceId: ws });
    const purged = await manage({ action: "purge", workspaceId: ws });
    if (!purged.isError) return undefined;
    // A scenario that purged it already leaves nothing to purge, which only a
    // successful listing of each kind can show; any other answer leaves it here.
    const refused = `${ws}: purge refused: ${textOf(purged).slice(0, 200)}`;
    for (const [action, key, idKey] of [
      ["list", "workspaces", "id"],
      ["list_deleted", "deleted", "workspaceId"],
    ] as const) {
      const r = await manage({ action });
      const rows = structured<Record<string, unknown>>(r)[key];
      if (r.isError || !Array.isArray(rows)) {
        return `${refused}; ${action} answered ${r.status}: ${textOf(r).slice(0, 200)}`;
      }
      if (rows.some((row) => (row as Record<string, unknown> | null)?.[idKey] === ws)) {
        return refused;
      }
    }
    return undefined;
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
  const client = new E2EClient(target.baseUrl);
  const second = target.capabilities.has("second-identity") ? target.bob : undefined;
  // A deployment's workspaces are real and every scenario writes, so there the
  // suite runs only in workspaces it creates, and deletes and purges them at the end.
  const deployment = target.kind === "deployment";
  const isolated = !deployment || target.capabilities.has("org-admin");
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
  const results: ScenarioResult[] = [];

  try {
    let ws = "";
    let bobWs: string | undefined;
    const needsBob = scenarios.some((s) => s.requires?.includes("second-identity"));
    if (deployment && isolated) {
      const stamp = Date.now().toString(36);
      ws = await createWorkspace(client, target.alice, `E2E run ${stamp}`);
      runOwned.push(ws);
      if (second && needsBob) {
        // Bob's own workspace, which Alice leaves once Bob is its admin.
        bobWs = await createWorkspace(client, target.alice, `E2E run ${stamp} (second)`);
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
    } else if (!deployment) {
      ws = await firstWorkspace(client, target.alice);
      bobWs = second && needsBob ? await firstWorkspace(client, second) : undefined;
    }

    for (const scenario of scenarios) {
      const t0 = Date.now();
      const row: ScenarioResult = {
        id: scenario.id,
        title: scenario.title,
        groups: scenario.groups ?? [],
        status: "pass",
        ms: 0,
        checks: [],
      };
      results.push(row);
      const missing: string[] = isolated
        ? (scenario.requires ?? []).filter((c) => !target.capabilities.has(c))
        : [ISOLATION];
      if (missing.length > 0) {
        row.status = "skip";
        row.skipReason = `needs ${missing.join(", ")}`;
        log(`- ${scenario.id}: skipped (${row.skipReason})`);
        continue;
      }
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
        async check(label, fn) {
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
          row.checks.push({ label, ok, evidence });
          log(`  ${ok ? "ok  " : "FAIL"} ${label} (${Date.now() - c0}ms)`);
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
      if (error) {
        row.status = "errored";
        row.error = error.split("\n").slice(0, 4).join("\n");
      } else if (row.checks.length === 0) {
        row.status = "fail";
        row.checks.push({ label: "a check", ok: false, evidence: "the scenario ran no check" });
      } else if (row.checks.some((c) => !c.ok)) {
        row.status = "fail";
      }
      row.ms = Date.now() - t0;
      if (Object.keys(notes).length > 0) row.notes = notes;
    }
  } finally {
    await dispose(runOwned);
  }

  const summary: Record<ScenarioStatus, number> = { pass: 0, fail: 0, errored: 0, skip: 0 };
  for (const r of results) summary[r.status]++;
  return {
    target: { label: target.label, kind: target.kind, baseUrl: target.baseUrl },
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    summary,
    scenarios: results,
    leftBehind,
  };
}
