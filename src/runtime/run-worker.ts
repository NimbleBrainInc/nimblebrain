/**
 * The run worker: how the kernel runs the work the tasks contract
 * (`ai.nimblebrain.tasks`, `contracts/tasks/CONTRACT.md` §5) says is owed.
 *
 * The bound implementation decides what runs and when it is due; the kernel
 * owns the clock, the work queue and the door. For every workspace it serves:
 *
 * 1. **Due.** It calls private `due` on an interval and at once on the change
 *    hint (`tasks://due/<workspaceId>`, watched per workspace as `host`), with
 *    its own `now` and an `until` past the next call. Each occurrence is
 *    enqueued on the work queue under its key, scoped to the workspace, not
 *    before its `notBefore`; each run in `cancel` this process holds is stopped.
 * 2. **Claim.** A claim is taken only while a run slot is free, and the slot is
 *    taken in the turn the claim returns. `begin_run` is called with the claim's
 *    attempt and token. A skip settles the item (an `interrupted` earlier run is
 *    ended with the host's own `end_run`, usage from metering).
 * 3. **Run.** The grant is verified (signature, contract, workspace) and the run
 *    acts as its owner, if that owner is a member now. At most one run per
 *    `exclusiveKey` per workspace is in flight: an in-process set, which is the
 *    whole of it because the filesystem queue serves one process
 *    (`multiProcess: false`); a queue for several processes brings the Leases
 *    provider with it. The work goes through the door (`executeTask`), which
 *    contains its input and notes, renders its output-schema instruction,
 *    lowers its limits to the operator's ceilings and enforces its spend
 *    accounts beside the host's own.
 * 4. **End.** `end_run` carries the closed outcome; its notices go to the
 *    workspace's inbox. The run's spend accounts stay open (an anchor that never
 *    spends) until that `end_run` is acknowledged, so the implementation's next
 *    balance includes the run's cost. A claim that is lost stops the run.
 *
 * Generic parts (claiming only with a free slot, leases, the lost claim, the
 * anchor) know nothing of tasks; the contract appears only in the private
 * calls and the outcome mapping. The kernel never names the plugin.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { EffectiveRunLimits } from "../config/runs.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { log } from "../observability/log.ts";
import { CONTRACTS_DIR } from "../plugins/contracts.ts";
import { type Claim, LeaseLostError, type WorkQueue } from "../providers/queue/types.ts";
import type { MeteredRun } from "../usage/aggregate.ts";
import type { AdmissionLease, RunAdmission } from "./admission.ts";
import {
  DeclaredSkillsUnavailableError,
  DeclaredToolsUnavailableError,
  ModelNotAllowedError,
  RunDeadlineExceededError,
  WorkspaceMembershipRevokedError,
} from "./errors.ts";
import type { RunGrants } from "./run-grant.ts";
import type { SpendBalances, SpendHold } from "./spend.ts";
import type { TaskRequest, TaskResult } from "./types.ts";

/** The tasks contract's permanent name: what the kernel asks its plugins' bindings for. */
export const TASKS_CONTRACT = "ai.nimblebrain.tasks";

/** The work queue item kind of an occurrence: its payload is `{ workspaceId, ref }`. */
export const RUN_ITEM_KIND = "tasks.run";

/** How often `due` is called for each workspace when no hint arrives. */
export const DUE_INTERVAL_MS = 30_000;
/** How far past `now` a `due` lists: always past the next call. */
const DUE_HORIZON_MS = 120_000;
/** A claim's lease, extended while its run is in flight. */
const LEASE_MS = 60_000;
const EXTEND_MS = 20_000;
/** How often the worker looks for an item nothing in this process announced. */
const CLAIM_POLL_MS = 5_000;
/** Waits between attempts to report a run's end before the claim is let go. */
const END_RUN_RETRY_MS = [1_000, 5_000, 15_000];
/** How long a `begin_run` that failed waits before its item is claimed again. */
const BEGIN_RETRY_MS = 30_000;
/** How long shutdown waits for stopped runs to report their end. */
const SHUTDOWN_GRACE_MS = 10_000;
/** How far back the ledger is read for an interrupted run's usage. */
const METER_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

const OUTCOME_MESSAGE_MAX = 2_000;
const MAX_TOOL_CALLS = 1_000;
const MAX_FILES = 100;

/** The change hint's URI for a workspace (CONTRACT.md §5.1). */
export function dueHintUri(workspaceId: string): string {
  return `tasks://due/${workspaceId}`;
}

/** A notice an implementation answers (CONTRACT.md §11). */
export interface RunNotice {
  id: string;
  title: string;
  body: string;
  level: "info" | "attention" | "urgent";
}

/** The outcome `end_run` carries (`run_outcome`). */
export interface RunOutcome {
  startedAt: string;
  endedAt: string;
  output: string;
  stopReason: string;
  error?: { code: string; transient: boolean; message?: string };
  usage: { inputTokens: number; outputTokens: number; iterations?: number };
  costUsd: number;
  toolCalls: Array<{ name: string; ok: boolean; errorReason?: string; ms: number }>;
  filesWritten: Array<{ uri: string; name?: string }>;
  wrapUpLimit?: string;
  unpricedCalls?: number;
  spendAccountId?: string;
  spendStop?: "exhausted" | "reserved";
  limits?: { maxIterations?: number; maxInputTokens?: number; maxRunDurationMs?: number };
  skillsDelivered?: Array<{ name: string; loadedBy: string; status?: string }>;
}

/** The work spec of a run answer (`work_spec`, kind `agent`). */
interface WorkSpec {
  kind: "agent";
  prompt: string;
  input?: unknown;
  notes?: string[];
  outputSchema?: Record<string, unknown>;
  allowedTools?: string[];
  skills?: string[];
  limits?: { maxIterations?: number; maxInputTokens?: number; maxRunDurationMs?: number };
  model?: string;
  thinkingEffort?: TaskRequest["thinkingEffort"];
  spendAccounts?: Array<{
    id: string;
    unit: "usd" | "input_tokens" | "output_tokens";
    remaining: number;
    sharedBy?: number;
  }>;
  exclusiveKey?: string;
  trigger?: "scheduled" | "manual" | "event";
}

type BeginAnswer =
  | {
      decision: "skip";
      reason: string;
      interrupted?: { runId: string; token: number };
      notices?: RunNotice[];
    }
  | { decision: "run"; runId: string; grant: string; work: WorkSpec };

/** The bound server, as the worker reaches it: as `host`, by contract. */
export interface TasksServer {
  /** The contract version this kernel consumes: the `version` on every private call. */
  hostVersion: string;
  call(
    tool: string,
    args: Record<string, unknown>,
    scope: { workspaceId: string; ownerId?: string },
  ): Promise<Record<string, unknown>>;
  watch(uri: string, scope: { workspaceId: string }): Promise<(() => Promise<void>) | null>;
  /** An identity for the server's current connection, which changes when it restarts. */
  connection(): object | null;
  /** Listen for `notifications/resources/updated`; returns an unsubscribe. */
  onResourceUpdated(listener: (uri: string) => void): () => void;
}

export interface RunWorkerDeps {
  server: TasksServer;
  queue: WorkQueue;
  admission: RunAdmission;
  spend: SpendBalances;
  grants: RunGrants;
  /** The door: `Runtime.executeTask`. */
  execute(request: TaskRequest): Promise<TaskResult>;
  /** The caps a run executes under: its work's, lowered to the operator's ceilings. */
  limitsOf(limits: WorkSpec["limits"]): EffectiveRunLimits;
  /** Whether `ownerId` is a member of `workspaceId` now. */
  isMember(workspaceId: string, ownerId: string): Promise<boolean>;
  /** Every workspace the kernel serves now: read at start, on each interval, and on a hint for one not served. */
  workspaceIds(): Promise<string[]>;
  /** Put notices in the workspace's inbox, once each. */
  deliver(workspaceId: string, notices: readonly RunNotice[]): void;
  /** A run's end was recorded: refresh its owner's views, report it. */
  ended(
    workspaceId: string,
    ownerId: string,
    run: { runId: string; outcome: RunOutcome; trigger?: string },
  ): void;
  /** What the ledger recorded for a run, for one interrupted with nothing reported. */
  metered(
    workspaceId: string,
    runId: string,
    range: { from: string; to: string },
  ): MeteredRun | undefined;
  /** Names this worker's claims. Default: one per process. */
  workerId?: string;
}

export interface RunWorker {
  start(): Promise<void>;
  /** Stop: no more claims; runs in flight are stopped and report their end, within a grace period. */
  stop(): Promise<void>;
  /** Serve a workspace now (one just created); the interval finds it otherwise. */
  serve(workspaceId: string): void;
  /** Stop serving a workspace (being deleted): no more `due`, its runs stopped. */
  drop(workspaceId: string): Promise<void>;
}

type StopCause = "cancelled" | "timeout" | "lost" | "shutdown";

interface DueAnswer {
  occurrences: Array<{ key: string; ref: string; notBefore?: string }>;
  cancel: string[];
  nextCursor: string | null;
}

/** The contract document's answer schemas, compiled once. */
interface Validators {
  due: ValidateFunction<DueAnswer>;
  begin: ValidateFunction<BeginAnswer>;
  end: ValidateFunction<{ notices: RunNotice[] }>;
  outcome: ValidateFunction<RunOutcome>;
}

function loadValidators(): Validators {
  const doc = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, "tasks", "v1", "contract.json"), "utf-8"),
  ) as { $id: string };
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  addFormats(ajv);
  ajv.addSchema(doc);
  function get<T>(def: string): ValidateFunction<T> {
    const fn = ajv.getSchema<T>(`${doc.$id}#/$defs/${def}`);
    if (!fn) throw new Error(`[run-worker] the tasks contract has no $defs/${def}`);
    return fn;
  }
  return {
    due: get<DueAnswer>("due_output"),
    begin: get<BeginAnswer>("begin_run_output"),
    end: get<{ notices: RunNotice[] }>("end_run_output"),
    outcome: get<RunOutcome>("run_outcome"),
  };
}

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, OUTCOME_MESSAGE_MAX);
}

/** The door's name for what woke a run. */
function doorTrigger(trigger: WorkSpec["trigger"]): TaskRequest["trigger"] {
  if (trigger === "manual") return "manual";
  if (trigger === "event") return "event";
  return "schedule";
}

/** A run refused before its first model call. */
function notStarted(
  code: string,
  transient: boolean,
  message: string,
  at = new Date(),
): RunOutcome {
  const now = at.toISOString();
  return {
    startedAt: now,
    endedAt: now,
    output: "",
    stopReason: "not_started",
    error: { code, transient, message: message.slice(0, OUTCOME_MESSAGE_MAX) },
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    toolCalls: [],
    filesWritten: [],
  };
}

/** Failure reasons that mean the call ran nothing: the model named a tool that does not exist. */
const MISNAMED = new Set(["invalid_tool_name", "unknown_identity_source"]);
/** Failure reasons that mean the tool could not be reached. */
const UNAVAILABLE = new Set([
  "unknown_tool_source",
  "workspace_access_denied",
  "reauth_required",
  "unknown_workspace",
  "connector_grant_denied",
]);
/** Failure reasons that mean a policy refused the call. */
const DENIED = new Set([
  "tool_permission_denied",
  "unattended_refused",
  "host_only_tool",
  "workspace_admin_required",
  "tool_not_allowed",
  "denied",
]);

/** A door tool call's reason as the contract's closed `errorReason`. */
function contractErrorReason(reason: string | undefined): string {
  if (reason === "bad_input") return "bad_input";
  if (reason === "timeout") return "timeout";
  if (reason && UNAVAILABLE.has(reason)) return "unavailable";
  if (reason && DENIED.has(reason)) return "denied";
  return "tool_error";
}

/** The run's tool calls by name, success, reason and duration, in call order; calls that ran nothing left out. */
function contractToolCalls(calls: TaskResult["toolCalls"]): RunOutcome["toolCalls"] {
  return calls
    .filter((c) => !c.held && !(c.errorReason && MISNAMED.has(c.errorReason)))
    .slice(0, MAX_TOOL_CALLS)
    .map((c) => ({
      name: c.name || "(unknown tool)",
      ok: c.ok === true,
      ...(c.ok === true ? {} : { errorReason: contractErrorReason(c.errorReason) }),
      ms: Math.max(0, Number.isFinite(c.ms) ? c.ms : 0),
    }));
}

/** Why a run the door returned stopped, as the contract's `stopReason` and `error`. */
function contractStop(
  result: Pick<TaskResult, "stopReason" | "finishReasonRaw">,
  cause: StopCause | undefined,
): Pick<RunOutcome, "stopReason" | "error"> {
  if (result.stopReason === "aborted" || result.stopReason === "cancelled" || cause) {
    switch (cause) {
      case "timeout":
        return { stopReason: "timeout" };
      case "cancelled":
        return { stopReason: "cancelled" };
      case "lost":
        return {
          stopReason: "error",
          error: {
            code: "interrupted",
            transient: true,
            message: "The host lost its claim on the run and stopped it.",
          },
        };
      default:
        return {
          stopReason: "error",
          error: {
            code: "internal",
            transient: true,
            message: "The host shut down while the run was in flight.",
          },
        };
    }
  }
  switch (result.stopReason) {
    case "complete":
    case "max_iterations":
    case "max_input_tokens":
    case "spend_limit":
    case "length":
    case "content_filter":
      return { stopReason: result.stopReason };
    case "error":
      return {
        stopReason: "error",
        error: { code: "model_error", transient: true, message: "A model call failed." },
      };
    default:
      return {
        stopReason: "other",
        error: {
          code: "internal",
          transient: false,
          message: `The model's turn ended without a recognized stop (provider stop reason: ${result.finishReasonRaw ?? "not reported"}).`,
        },
      };
  }
}

/** A run that threw at the door, as the outcome its refusal means. */
function thrownOutcome(err: unknown, cause: StopCause | undefined, startedAt: Date): RunOutcome {
  if (cause) {
    const empty = { stopReason: "aborted", toolCalls: [] } as Pick<
      TaskResult,
      "stopReason" | "finishReasonRaw"
    >;
    return { ...notStarted("internal", true, "", startedAt), ...contractStop(empty, cause) };
  }
  if (err instanceof WorkspaceMembershipRevokedError) {
    return notStarted("membership_revoked", false, err.message, startedAt);
  }
  if (err instanceof DeclaredToolsUnavailableError) {
    return notStarted("tools_unavailable", false, err.message, startedAt);
  }
  if (err instanceof DeclaredSkillsUnavailableError) {
    return notStarted("skills_unavailable", false, err.message, startedAt);
  }
  if (err instanceof ModelNotAllowedError) {
    return notStarted("model_error", false, err.message, startedAt);
  }
  if (err instanceof RunDeadlineExceededError) {
    return {
      ...notStarted("internal", false, err.message, startedAt),
      stopReason: "timeout",
      error: undefined,
    };
  }
  return notStarted("internal", false, messageOf(err), startedAt);
}

/** When an item that could not be begun is claimed again. */
function retryLater(): string {
  return new Date(Date.now() + BEGIN_RETRY_MS).toISOString();
}

/** The caps a run executed under, as the outcome states them. */
function limitsOf(limits: EffectiveRunLimits): NonNullable<RunOutcome["limits"]> {
  return {
    maxIterations: limits.maxIterations,
    ...(limits.maxInputTokens !== undefined ? { maxInputTokens: limits.maxInputTokens } : {}),
    maxRunDurationMs: limits.maxRunDurationMs,
  };
}

/** The door request for a run's work, as its owner, in its workspace, under its caps and slot. */
function doorRequest(
  work: WorkSpec,
  run: {
    ownerId: string;
    workspaceId: string;
    runId: string;
    lease: AdmissionLease;
    limits: EffectiveRunLimits;
  },
): TaskRequest {
  const { limits } = run;
  return {
    prompt: work.prompt,
    ...(work.input !== undefined ? { input: work.input } : {}),
    ...(work.notes?.length ? { notes: work.notes } : {}),
    ...(work.outputSchema ? { outputSchema: work.outputSchema } : {}),
    ...(work.allowedTools?.length ? { allowedTools: work.allowedTools } : {}),
    ...(work.skills?.length ? { skills: work.skills } : {}),
    ...(work.model ? { model: work.model } : {}),
    ...(work.thinkingEffort ? { thinkingEffort: work.thinkingEffort } : {}),
    ...(work.spendAccounts?.length ? { spendAccounts: work.spendAccounts } : {}),
    trigger: doorTrigger(work.trigger),
    // The grant's owner and no more: no org role, so the run passes the
    // permission checks inside its tools exactly as its owner's standing
    // authority allows, never as whoever asked for it.
    identity: { id: run.ownerId } as UserIdentity,
    workspaceId: run.workspaceId,
    maxIterations: limits.maxIterations,
    ...(limits.maxInputTokens !== undefined ? { maxRunInputTokens: limits.maxInputTokens } : {}),
    maxRunDurationMs: limits.maxRunDurationMs,
    runId: run.runId,
    admission: run.lease,
  };
}

/** Create the worker. Nothing runs until {@link RunWorker.start}. */
export function createRunWorker(deps: RunWorkerDeps): RunWorker {
  const validators = loadValidators();
  const version = deps.server.hostVersion;
  const workerId = deps.workerId ?? `worker_${crypto.randomUUID().slice(0, 12)}`;

  interface Served {
    polling: boolean;
    again: boolean;
    watchedConnection: object | null;
    closeWatch: (() => Promise<void>) | null;
  }
  const served = new Map<string, Served>();
  /** Runs this process has in flight, by run id. */
  const running = new Map<string, { workspaceId: string; stop: (cause: StopCause) => void }>();
  /** Exclusive keys held, as `<workspace>\0<key>`. */
  const exclusive = new Set<string>();
  /** Runs holding each spend account, this process. */
  const accountHolders = new Map<string, number>();
  const inflight = new Set<Promise<void>>();
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  let pumping = false;
  let pumpAgain = false;

  const scope = (workspaceId: string) => ({ workspaceId });

  function track(work: Promise<void>): void {
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  }

  // ── Due ────────────────────────────────────────────────────────────────────

  async function ensureWatch(workspaceId: string, st: Served): Promise<void> {
    const connection = deps.server.connection();
    if (!connection || connection === st.watchedConnection) return;
    await st.closeWatch?.().catch(() => {});
    st.closeWatch = await deps.server.watch(dueHintUri(workspaceId), scope(workspaceId));
    st.watchedConnection = st.closeWatch ? connection : null;
  }

  /** One page of `due`; every page repeats the first's `now` and `until`. */
  async function duePage(
    workspaceId: string,
    args: { version: string; now: string; until: string },
    cursor: string | null,
  ): Promise<DueAnswer> {
    const page = await deps.server.call(
      "due",
      cursor ? { ...args, cursor } : args,
      scope(workspaceId),
    );
    if (!validators.due(page)) {
      throw new Error(`due answered outside its schema: ${JSON.stringify(validators.due.errors)}`);
    }
    return page;
  }

  async function listDue(workspaceId: string): Promise<void> {
    const now = new Date();
    const args = {
      version,
      now: now.toISOString(),
      until: new Date(now.getTime() + DUE_HORIZON_MS).toISOString(),
    };
    const cancel = new Set<string>();
    let cursor: string | null = null;
    do {
      const answer = await duePage(workspaceId, args, cursor);
      for (const occurrence of answer.occurrences) await enqueue(workspaceId, occurrence);
      for (const id of answer.cancel) cancel.add(id);
      cursor = answer.nextCursor;
    } while (cursor && served.has(workspaceId));
    for (const runId of cancel) {
      const run = running.get(runId);
      if (run?.workspaceId === workspaceId) run.stop("cancelled");
    }
  }

  async function enqueue(
    workspaceId: string,
    occurrence: { key: string; ref: string; notBefore?: string },
  ): Promise<void> {
    const { created } = await deps.queue.enqueue({
      scope: workspaceId,
      kind: RUN_ITEM_KIND,
      payload: { workspaceId, ref: occurrence.ref },
      idempotencyKey: occurrence.key,
      ...(occurrence.notBefore ? { notBefore: occurrence.notBefore } : {}),
    });
    if (!created) return;
    const wait = occurrence.notBefore ? Date.parse(occurrence.notBefore) - Date.now() : 0;
    if (wait > 0) setTimeout(() => void pump(), wait + 5).unref?.();
    else void pump();
  }

  /** Call `due` for a workspace now, or again once the call in flight ends. */
  function poll(workspaceId: string): void {
    const st = served.get(workspaceId);
    if (!st || stopped) return;
    if (st.polling) {
      st.again = true;
      return;
    }
    st.polling = true;
    track(
      (async () => {
        try {
          do {
            st.again = false;
            await ensureWatch(workspaceId, st);
            await listDue(workspaceId);
          } while (st.again && !stopped && served.has(workspaceId));
        } catch (err) {
          log.warn("[run-worker] due failed", { workspaceId, error: messageOf(err) });
        } finally {
          st.polling = false;
        }
      })(),
    );
  }

  // ── Claim ──────────────────────────────────────────────────────────────────

  /** Claim items while a run slot is free; each claim takes its slot in the turn it returns. */
  async function pump(): Promise<void> {
    if (stopped) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        while (!stopped && deps.admission.hasFreeSlot() && (await claimOne())) {
          // Each claim started its run; look for the next while a slot is free.
        }
      } while (pumpAgain && !stopped);
    } catch (err) {
      log.warn("[run-worker] claim failed", { error: messageOf(err) });
    } finally {
      pumping = false;
    }
  }

  /** Claim one item and start its run, taking its slot in this turn. False when there is nothing to take. */
  async function claimOne(): Promise<boolean> {
    const claim = await deps.queue.claim({ workerId, leaseMs: LEASE_MS, kinds: [RUN_ITEM_KIND] });
    if (!claim) return false;
    const payload = claim.payload as { workspaceId?: unknown; ref?: unknown } | null;
    const workspaceId = typeof payload?.workspaceId === "string" ? payload.workspaceId : "";
    const ref = typeof payload?.ref === "string" ? payload.ref : "";
    if (!workspaceId || !ref) {
      await settle(claim, undefined, "malformed run item");
      return true;
    }
    const ticket = deps.admission.request({ workspaceId });
    if (ticket.state !== "admitted") {
      await settle(claim, new Date().toISOString(), "no free run slot");
      return false;
    }
    track(runClaim(claim, workspaceId, ref, ticket.lease));
    return true;
  }

  async function settle(claim: Claim, retryAt?: string, error = "run worker"): Promise<void> {
    try {
      if (retryAt === undefined) await deps.queue.complete(claim);
      else await deps.queue.fail(claim, { error, retryAt });
    } catch (err) {
      if (!(err instanceof LeaseLostError)) {
        log.warn("[run-worker] could not settle a run item", { error: messageOf(err) });
      }
    }
  }

  /**
   * Keep a claim's lease while its run is in flight. `onLost` fires once when
   * the claim is lost; `stop` ends the keeping.
   */
  function keepClaim(claim: Claim, onLost: () => void): { stop: () => void } {
    let held = claim;
    const timer = setInterval(() => {
      deps.queue.extend(held, LEASE_MS).then(
        (next) => {
          held = next;
        },
        (err) => {
          if (err instanceof LeaseLostError) onLost();
        },
      );
    }, EXTEND_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }

  /** `begin_run` for a claim, or null when its item was settled here instead. */
  async function beginRun(
    claim: Claim,
    workspaceId: string,
    ref: string,
  ): Promise<BeginAnswer | null> {
    let raw: Record<string, unknown>;
    try {
      raw = await deps.server.call(
        "begin_run",
        { version, ref, attempt: claim.attempt, token: claim.token, now: new Date().toISOString() },
        scope(workspaceId),
      );
    } catch (err) {
      // A stale token means a newer claim holds the item; nothing more to do here.
      if (codeOf(err) === "token_stale") await settle(claim);
      else await settle(claim, retryLater(), messageOf(err));
      if (codeOf(err) !== "token_stale") {
        log.warn("[run-worker] begin_run failed", { workspaceId, error: messageOf(err) });
      }
      return null;
    }
    if (validators.begin(raw)) return raw;
    // Work the host does not fully understand is refused, never ignored.
    const runId = typeof raw.runId === "string" ? raw.runId : undefined;
    if (runId) {
      const outcome = notStarted(
        "work_invalid",
        false,
        "The run's work names what this host does not know.",
      );
      await endRun(workspaceId, runId, claim.token, outcome);
    } else {
      log.warn("[run-worker] begin_run answered outside its schema", { workspaceId });
    }
    await settle(claim);
    return null;
  }

  async function runClaim(
    claim: Claim,
    workspaceId: string,
    ref: string,
    lease: AdmissionLease,
  ): Promise<void> {
    let stopRun: ((cause: StopCause) => void) | null = null;
    let lost = false;
    const keeping = keepClaim(claim, () => {
      lost = true;
      stopRun?.("lost");
    });
    let release: () => void = () => {};
    try {
      const answer = served.has(workspaceId) ? await beginRun(claim, workspaceId, ref) : null;
      if (!served.has(workspaceId) && answer === null) await settle(claim);
      if (!answer) return;
      if (answer.decision === "skip") {
        await skipped(workspaceId, answer);
        await settle(claim);
        return;
      }
      const run = await runWork(workspaceId, answer, lease, (stop) => {
        stopRun = stop;
        if (lost) stop("lost");
      });
      release = run.release;
      await reportEnd(claim, workspaceId, answer, run);
    } catch (err) {
      log.error("[run-worker] run item failed", { workspaceId, error: messageOf(err) });
      await settle(claim, retryLater(), messageOf(err));
    } finally {
      keeping.stop();
      release();
      lease.release();
      void pump();
    }
  }

  /** A skip: its notices delivered, an earlier claim's interrupted run closed. */
  async function skipped(
    workspaceId: string,
    answer: Extract<BeginAnswer, { decision: "skip" }>,
  ): Promise<void> {
    if (answer.notices?.length) deps.deliver(workspaceId, answer.notices);
    if (answer.interrupted) await closeInterrupted(workspaceId, answer.interrupted);
  }

  /** Report a run's end and settle its item; an unacknowledged end lets the item go for the next claim to close. */
  async function reportEnd(
    claim: Claim,
    workspaceId: string,
    answer: Extract<BeginAnswer, { decision: "run" }>,
    run: { outcome: RunOutcome; ownerId?: string },
  ): Promise<void> {
    const notices = await endRun(workspaceId, answer.runId, claim.token, run.outcome);
    if (notices === null) {
      // The next claim's `begin_run` answers it interrupted, and the host closes it then.
      await settle(claim, new Date().toISOString(), "end_run was not acknowledged");
      return;
    }
    if (notices.length > 0) deps.deliver(workspaceId, notices);
    if (run.ownerId) {
      deps.ended(workspaceId, run.ownerId, {
        runId: answer.runId,
        outcome: run.outcome,
        ...(answer.work.trigger ? { trigger: answer.work.trigger } : {}),
      });
    }
    await settle(claim);
  }

  // ── Run ────────────────────────────────────────────────────────────────────

  /** Why a run answered may not start here, with its owner when the grant verified. */
  async function refusal(
    workspaceId: string,
    answer: Extract<BeginAnswer, { decision: "run" }>,
  ): Promise<{ outcome?: RunOutcome; ownerId?: string }> {
    const ownerId = deps.grants.verify(answer.grant, TASKS_CONTRACT, workspaceId);
    if (!ownerId) {
      return {
        outcome: notStarted(
          "grant_invalid",
          false,
          "The run's grant does not verify for this workspace.",
        ),
      };
    }
    if (!(await deps.isMember(workspaceId, ownerId))) {
      const why = "The run's owner is no longer a member of the workspace.";
      return { outcome: notStarted("membership_revoked", false, why), ownerId };
    }
    const key = answer.work.exclusiveKey;
    if (key && exclusive.has(`${workspaceId}\u0000${key}`)) {
      const why = "Another run with the same exclusive key is in flight.";
      return { outcome: notStarted("exclusive_busy", true, why), ownerId };
    }
    return { ownerId };
  }

  /**
   * Take what a run holds until its end is acknowledged: its exclusive key, and
   * an anchor on its spend accounts (a hold that never spends), so the live
   * balance still carries its spend for any run that starts before its end
   * lands. Returns the release.
   */
  function hold(workspaceId: string, work: WorkSpec): () => void {
    const key = work.exclusiveKey ? `${workspaceId}\u0000${work.exclusiveKey}` : undefined;
    if (key) exclusive.add(key);
    const accounts = work.spendAccounts ?? [];
    const anchor: SpendHold | null =
      accounts.length > 0 ? deps.spend.open(accounts, { model: "", rates: null }) : null;
    for (const a of accounts) accountHolders.set(a.id, (accountHolders.get(a.id) ?? 0) + 1);
    return () => {
      if (key) exclusive.delete(key);
      anchor?.release();
      for (const a of accounts) {
        const n = (accountHolders.get(a.id) ?? 1) - 1;
        if (n > 0) accountHolders.set(a.id, n);
        else accountHolders.delete(a.id);
      }
    };
  }

  /**
   * Run one answered run through the door. Resolves with its outcome, its
   * owner, and the release of what it holds until its end is acknowledged.
   */
  async function runWork(
    workspaceId: string,
    answer: Extract<BeginAnswer, { decision: "run" }>,
    lease: AdmissionLease,
    onStop: (stop: (cause: StopCause) => void) => void,
  ): Promise<{ outcome: RunOutcome; ownerId?: string; release: () => void }> {
    const { runId, work } = answer;
    const startedAt = new Date();
    const refused = await refusal(workspaceId, answer);
    const ownerId = refused.ownerId;
    if (refused.outcome || !ownerId) {
      return {
        outcome: refused.outcome ?? notStarted("grant_invalid", false, "No owner."),
        ...(ownerId ? { ownerId } : {}),
        release: () => {},
      };
    }
    const release = hold(workspaceId, work);
    const limits = deps.limitsOf(work.limits);
    const controller = new AbortController();
    let cause: StopCause | undefined;
    const stop = (why: StopCause) => {
      if (cause) return;
      cause = why;
      controller.abort(why);
    };
    running.set(runId, { workspaceId, stop });
    onStop(stop);
    if (stopped) stop("shutdown");
    const timer = setTimeout(() => stop("timeout"), limits.maxRunDurationMs);
    try {
      const request = doorRequest(work, { ownerId, workspaceId, runId, lease, limits });
      const result = await deps.execute({ ...request, signal: controller.signal });
      return { outcome: outcomeOf(result, cause, startedAt, limits), ownerId, release };
    } catch (err) {
      return { outcome: thrownOutcome(err, cause, startedAt), ownerId, release };
    } finally {
      clearTimeout(timer);
      running.delete(runId);
    }
  }

  /** What the door returned, as the closed outcome. */
  function outcomeOf(
    result: TaskResult,
    cause: StopCause | undefined,
    startedAt: Date,
    limits: EffectiveRunLimits,
  ): RunOutcome {
    const stop = contractStop(result, cause);
    const outcome: RunOutcome = {
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      output: result.output,
      ...stop,
      usage: {
        inputTokens: Math.max(0, Math.round(result.usage.inputTokens)),
        outputTokens: Math.max(0, Math.round(result.usage.outputTokens)),
        iterations: Math.max(0, result.usage.iterations),
      },
      costUsd: Math.max(0, result.costUsd),
      toolCalls: contractToolCalls(result.toolCalls),
      filesWritten: result.filesWritten.slice(0, MAX_FILES),
      limits: limitsOf(limits),
    };
    return { ...outcome, ...outcomeDetail(result, stop.stopReason) };
  }

  /** The outcome's fields that hold only with some stops or some results. */
  function outcomeDetail(result: TaskResult, stopReason: string): Partial<RunOutcome> {
    const detail: Partial<RunOutcome> = {};
    if (result.unpricedCalls && result.unpricedCalls > 0)
      detail.unpricedCalls = result.unpricedCalls;
    if (stopReason === "complete" && result.wrapUpLimit) detail.wrapUpLimit = result.wrapUpLimit;
    if (stopReason === "spend_limit") {
      if (result.spendAccountId) detail.spendAccountId = result.spendAccountId;
      detail.spendStop = spendStopOf(result.spendAccountId);
    }
    if (result.skillsDelivered?.length) {
      detail.skillsDelivered = result.skillsDelivered.map((s) => ({
        name: s.name,
        loadedBy: s.loadedBy,
        ...(s.status ? { status: s.status } : {}),
      }));
    }
    return detail;
  }

  /**
   * Whether a spend stop was the account running out, or other runs'
   * reservations holding what was left: `reserved` when another run in flight
   * here names the account and its balance is still above zero.
   */
  function spendStopOf(accountId: string | undefined): "exhausted" | "reserved" {
    if (!accountId) return "exhausted";
    const others = (accountHolders.get(accountId) ?? 0) > 1;
    return others && (deps.spend.balance(accountId) ?? 0) > 0 ? "reserved" : "exhausted";
  }

  // ── End ────────────────────────────────────────────────────────────────────

  /** Report a run's end; its notices, or null when no attempt was acknowledged. */
  async function endRun(
    workspaceId: string,
    runId: string,
    token: number,
    outcome: RunOutcome,
  ): Promise<RunNotice[] | null> {
    let sent = outcome;
    if (!validators.outcome(sent)) {
      log.error("[run-worker] a run's outcome falls outside its schema", {
        runId,
        errors: JSON.stringify(validators.outcome.errors),
      });
      sent = notStarted("internal", false, "The host could not describe how the run ended.");
    }
    for (const wait of [...END_RUN_RETRY_MS, undefined]) {
      const answer = await sendEnd(workspaceId, runId, token, sent);
      if (answer !== "retry") return answer;
      if (wait === undefined || stopped) return null;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    return null;
  }

  /** One `end_run`: its notices, or `retry` when it may land on another attempt. */
  async function sendEnd(
    workspaceId: string,
    runId: string,
    token: number,
    outcome: RunOutcome,
  ): Promise<RunNotice[] | "retry"> {
    try {
      const answer = await deps.server.call(
        "end_run",
        { version, runId, token, outcome },
        scope(workspaceId),
      );
      return validators.end(answer) ? answer.notices : [];
    } catch (err) {
      const code = codeOf(err);
      // The run is ended under another token, or was never begun: nothing to repeat.
      if (code === "token_stale" || code === "run_not_found") return [];
      log.warn("[run-worker] end_run failed", { workspaceId, runId, error: messageOf(err) });
      return "retry";
    }
  }

  /**
   * End an earlier claim's run that began and never reported: stop it if this
   * process still runs it (it then reports its own end), else report it
   * interrupted with what the ledger recorded for it.
   */
  async function closeInterrupted(
    workspaceId: string,
    interrupted: { runId: string; token: number },
  ): Promise<void> {
    const here = running.get(interrupted.runId);
    if (here) {
      here.stop("lost");
      return;
    }
    const now = new Date();
    const metered = deps.metered(workspaceId, interrupted.runId, {
      from: new Date(now.getTime() - METER_WINDOW_MS).toISOString().slice(0, 10),
      to: now.toISOString().slice(0, 10),
    });
    const outcome: RunOutcome = {
      startedAt: metered?.firstAt ?? now.toISOString(),
      endedAt: now.toISOString(),
      output: "",
      stopReason: "error",
      error: {
        code: "interrupted",
        transient: true,
        message: "The run began under an earlier claim that was lost before it reported its end.",
      },
      usage: { inputTokens: metered?.inputTokens ?? 0, outputTokens: metered?.outputTokens ?? 0 },
      costUsd: Math.max(0, metered?.costUsd ?? 0),
      toolCalls: [],
      filesWritten: [],
    };
    const notices = await endRun(workspaceId, interrupted.runId, interrupted.token, outcome);
    if (notices?.length) deps.deliver(workspaceId, notices);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  function serve(workspaceId: string): void {
    if (stopped || served.has(workspaceId)) return;
    served.set(workspaceId, {
      polling: false,
      again: false,
      watchedConnection: null,
      closeWatch: null,
    });
    poll(workspaceId);
  }

  /** Serve every workspace that exists and is not served yet. */
  async function refresh(): Promise<void> {
    try {
      for (const workspaceId of await deps.workspaceIds()) serve(workspaceId);
    } catch (err) {
      log.warn("[run-worker] could not list workspaces", { error: messageOf(err) });
    }
  }

  return {
    async start() {
      unsubscribe = deps.server.onResourceUpdated((uri) => {
        const prefix = "tasks://due/";
        if (!uri.startsWith(prefix)) return;
        const workspaceId = uri.slice(prefix.length);
        if (served.has(workspaceId)) poll(workspaceId);
        else void refresh();
      });
      await refresh();
      const due = setInterval(() => {
        void refresh().then(() => {
          for (const workspaceId of served.keys()) poll(workspaceId);
        });
      }, DUE_INTERVAL_MS);
      const claims = setInterval(() => void pump(), CLAIM_POLL_MS);
      due.unref?.();
      claims.unref?.();
      timers.push(due, claims);
      void pump();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      unsubscribe?.();
      for (const run of running.values()) run.stop("shutdown");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        }),
      ]);
      clearTimeout(timer);
      for (const st of served.values()) await st.closeWatch?.().catch(() => {});
      served.clear();
    },
    serve,
    async drop(workspaceId) {
      const st = served.get(workspaceId);
      served.delete(workspaceId);
      await st?.closeWatch?.().catch(() => {});
      for (const run of running.values()) {
        if (run.workspaceId === workspaceId) run.stop("cancelled");
      }
    },
  };
}
