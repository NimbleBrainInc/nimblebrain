/**
 * The records the tasks plugin keeps, as they are stored. Every type here is
 * this plugin's own; the contract's shapes (inputs, outputs, the work spec, the
 * outcome) are the published document's, and `views.ts` and `flow.ts` turn
 * these records into them.
 *
 * Instants are ISO 8601 strings. Every instant a decision is taken on came
 * from the host (`due`'s `now`, `begin_run`'s `now`, `offer_event`'s `now`,
 * an outcome's `startedAt`/`endedAt`); `createdAt`/`updatedAt`/`requestedAt`
 * are this plugin's own clock and only label a record (CONTRACT.md §6).
 */

/** A schedule as a caller writes it, and as it is stored: exactly one form. */
export type Schedule =
  | { cron: string; timezone: string }
  | { at: string }
  | { intervalMs: number }
  | { match: EventMatch; debounceMs?: number; maxFiresPerHour?: number };

/** Which routed notifications an event schedule wants. */
export interface EventMatch {
  source?: string;
  name?: string;
  level?: NoticeLevel;
}

export type NoticeLevel = "info" | "attention" | "urgent";

export type ScheduleType = "cron" | "interval" | "once" | "event" | "none";

export interface TokenBudget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  period?: "daily" | "monthly";
}

/** The fields a definition carries beyond its identity, schedule and prompt. */
export interface DefinitionFields {
  description?: string;
  skills?: string[];
  model?: string;
  thinkingEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  allowedTools?: string[];
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  tokenBudget?: TokenBudget;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** How a once schedule's one occurrence ended. */
export interface OnceDone {
  at: string;
  outcome: "ran" | "missed";
}

/** Tokens a task's runs used in one budget window. */
export interface WindowUsage {
  /** `lifetime`, a UTC day (`YYYY-MM-DD`) or a UTC month (`YYYY-MM`). */
  window: string;
  input: number;
  output: number;
}

/** A task definition and the state the plugin keeps for it. */
export interface TaskDef extends DefinitionFields {
  /**
   * A random id minted when the definition is created, never reused: occurrence
   * refs, spend account ids and the exclusive key name the definition by it, so
   * a task deleted and created again under the same id is a new one.
   */
  uid: string;
  id: string;
  ownerId: string;
  name: string;
  prompt: string;
  schedule?: Schedule;
  kind: "saved" | "oneoff";
  enabled: boolean;
  /** The run grant of the latest grant-marked call that named this definition, verbatim. */
  grant: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The occurrence a timed schedule owes next. Absent on a timed schedule that
   * was saved or changed since: the next `due` anchors it on its `now`.
   */
  nextRunAt?: string;
  /** The scheduled run begun and not yet ended, by id. */
  inFlight?: string;
  onceDone?: OnceDone;
  /**
   * The once occurrence (`nextRunAt`) a `due` has listed: produced, so it is the host's to
   * run however late it is claimed. Its lateness was judged on the `due` that produced it.
   */
  onceListed?: string;
  runCount: number;
  consecutiveErrors: number;
  transientErrors?: number;
  /** The failed run whose notice stands for the current failing stretch. */
  failureNoticeRunId?: string;
  disabledAt?: string;
  disabledReason?: string;
  lastRunAt?: string;
  lastRunLabel?: string;
  usage: WindowUsage;
  /**
   * The host's `now` of the first `due` after the definition was saved: the host instant a
   * one-off's retention is judged from, since `createdAt` is this plugin's own clock.
   */
  seenAt?: string;
  /** Events this task accepted, by `source` NUL `id`, with the host's `now` they arrived at. */
  eventsSeen?: Record<string, string>;
}

/** How a run ended, in the stored vocabulary execution and label are derived from. */
export type RunStatus =
  | "queued"
  | "running"
  | "success"
  | "degraded"
  | "failure"
  | "timeout"
  | "cancelled"
  | "skipped";

export type Trigger = "scheduled" | "manual" | "event";

/** What a schema check of the deliverable decided. */
export interface Assessment {
  verdict: "pass" | "fail" | "not_assessed";
  reason?: { code: string; message: string };
  schema?: { valid: boolean; errors?: string[] };
  assessedAt: string;
}

export interface Notice {
  id: string;
  title: string;
  body: string;
  level: NoticeLevel;
}

/** An event the host offered, as the run carries it: its presentation only. */
export interface OfferedEvent {
  id: string;
  source: string;
  name: string;
  level: NoticeLevel;
  title: string;
  subject?: string;
  body?: string;
  receivedAt: string;
}

/** One run: asked for, begun, or ended. */
export interface RunRecord {
  id: string;
  taskId: string;
  /** The definition the run belongs to (`TaskDef.uid`). */
  taskUid: string;
  ownerId: string;
  trigger: Trigger;
  status: RunStatus;
  requestedAt?: string;
  /** Not due before this instant (an event occurrence's debounce). */
  notBefore?: string;
  startedAt?: string;
  completedAt?: string;
  /** The occurrence ref `begin_run` answered with this run, and the token of that claim. */
  ref?: string;
  token?: number;
  /** Asked to stop after `begin_run` answered it: listed in `due`'s `cancel` until it ends. */
  cancelRequested?: true;
  /** A later claim of its ref arrived first: recorded interrupted until its `end_run` lands. */
  interruptedAt?: string;
  /** The once occurrence a scheduled run is (`schedule.at` when it began). */
  onceAt?: string;
  /** Whether a JSON input was given (it is kept beside the record). */
  hasInput?: true;
  idempotencyKey?: string;
  batchId?: string;
  batchIndex?: number;
  /** How many runs shared the budgets it ran under (a batch's sharing when it began). */
  sharedBy?: number;
  events?: OfferedEvent[];
  error?: string;
  transient?: boolean;
  stopReason?: string;
  spendAccountId?: string;
  spendStop?: string;
  resultPreview?: string;
  hasOutput?: true;
  inputTokens: number;
  outputTokens: number;
  iterations: number;
  toolCalls: number;
  costUsd?: number;
  unpricedCalls?: number;
  unrecoveredToolFailures?: string[];
  assessment?: Assessment;
  /** What `end_run` answered, so a repeat answers the same. */
  notices?: Notice[];
}

/** What a claim of a ref was answered, kept for a repeat of the same token. */
export type FenceAnswer =
  | { decision: "run"; runId: string }
  | {
      decision: "skip";
      reason: string;
      interrupted?: { runId: string; token: number };
      notices?: Notice[];
    };

export interface Fence {
  /** The highest token seen for the ref. */
  token: number;
  answer: FenceAnswer;
  /** The host's `now` of the claim that wrote it. */
  at: string;
}

/** What `begin_run` answered a run with, kept so a repeat answers the same. */
export interface RunAnswer {
  grant: string;
  work: Record<string, unknown>;
}

export type BatchState = "running" | "paused" | "completed" | "cancelled";

export interface BatchItem {
  state: "pending" | "queued" | "running" | "done";
  runId?: string;
  previousRunIds?: string[];
  execution?: string;
  verdict?: "pass" | "fail" | "not_assessed";
  degraded?: true;
  costUsd?: number;
  error?: string;
  errorCode?: "exceeds_share";
}

export interface Batch {
  id: string;
  taskId: string;
  taskUid: string;
  ownerId: string;
  name?: string;
  concurrency: number;
  /** How many runs share the budget, when a budget stop lowered it below `concurrency`. */
  sharing?: number;
  budgetUsd?: number;
  stopWhen?: { minPassRate: number; afterItems: number };
  stopRuleDisarmed?: true;
  state: BatchState;
  pause?: {
    reason: "manual" | "budget" | "pass_rate" | "unavailable";
    message: string;
    at: string;
  };
  /** No item starts until another of the batch's runs ends (another run's reservation refused one). */
  waitForSettle?: true;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  items: BatchItem[];
}

/** What an idempotency key names. */
export interface KeyEntry {
  runId?: string;
  batchId?: string;
  taskId: string;
}

/** Everything a workspace holds except ended runs, which are kept in their own log. */
export interface WorkspaceState {
  version: 1;
  /** Definitions by owner, then by task id. */
  tasks: Record<string, Record<string, TaskDef>>;
  /** Runs asked for, begun, or provisionally interrupted: every run whose `end_run` has not landed. */
  open: Record<string, RunRecord>;
  fences: Record<string, Fence>;
  batches: Record<string, Batch>;
  /** Idempotency keys by owner NUL tool NUL key. */
  keys: Record<string, KeyEntry>;
  /**
   * The committed ended-runs log: its file and its length in bytes. Bytes past `length` were
   * appended by a call that never committed, and are cut off on load.
   */
  log: { file: string; length: number };
}

export function emptyState(): WorkspaceState {
  return {
    version: 1,
    tasks: {},
    open: {},
    fences: {},
    batches: {},
    keys: {},
    log: { file: "runs-0.jsonl", length: 0 },
  };
}
