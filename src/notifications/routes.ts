/**
 * Routes — the first thing in this design that reaches a human outside the app.
 *
 * A notification lands in the inbox and this decides whether it goes anywhere
 * else. An operator wrote the rule; the runtime evaluates it, clamps it by the
 * source's ceiling, calls the tool as the rule's author, and writes down what
 * happened.
 *
 * Four properties hold it together:
 *
 *   - **The inbox is the guarantee and this is downstream of it.** Evaluation
 *     runs after the durable write and never rolls it back. A route that
 *     throws, a ledger write that fails, a workspace record that cannot be
 *     read — none of them cost the item.
 *   - **The ledger IS the retry state.** Every matched target gets a row
 *     before its first attempt, so a runtime that restarts mid-delivery finds
 *     its outstanding work by reading what it already wrote. There is no
 *     queue, no worker and no second copy of "what is owed".
 *   - **Targets are independent.** They run in the order the route lists them,
 *     one at a time, each in its own guard: a Slack post that times out does
 *     not stop the mail that was supposed to follow it.
 *   - **Nothing here decides what a principal may do.** The dispatch does, and
 *     this reads its answer. `denied` means a gate refused and retrying
 *     changes nothing until configuration does; `error` means the call did not
 *     complete. That split is not re-derived here, and a route naming a
 *     forbidden tool is refused by the door rather than by a list kept beside
 *     it.
 *
 * **Delivery is at-least-once.** A call that times out may have run: the
 * runtime knows only that no answer came back. So a retried target can fire a
 * tool twice, and a route naming something non-idempotent — anything that
 * mints, rotates or charges — should be written knowing that. Bounding the
 * retries is the mitigation; there is no exactly-once to be had over a tool
 * surface the runtime does not control.
 */

import {
  notificationSourceLabel,
  notificationsDeliveredTotal,
  notificationsRoutesMatchedTotal,
  notificationsTemplateMissesTotal,
} from "../api/metrics.ts";
import { backoffDelay } from "../bundles/automations/src/scheduler.ts";
import type { EventSink } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import type {
  UnattendedDispatchOptions,
  UnattendedDispatchResult,
} from "../orchestrator/unattended-dispatch.ts";
import type {
  DeliveryOutcome,
  DeliveryRecord,
  NotificationDeliverTarget,
} from "../tools/platform/schemas/notifications.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { type NotificationRoute, readNotificationsConfig, setRouteDisabled } from "./config.ts";
import { matchesNameGlob } from "./name-glob.ts";
import type { NotificationRef, NotificationStore } from "./store.ts";
import { renderDeliverInput } from "./template.ts";
import {
  NOTIFICATION_LEVEL_RANK,
  type Notification,
  notificationEffectiveLevel,
  notificationId,
  notificationPresentation,
} from "./types.ts";

/**
 * Attempts one tool target gets before the row goes `failed`, and the waits
 * between them.
 *
 * Three attempts spanning five minutes: immediately, a minute later, four
 * minutes after that. Long enough to ride out a connector restart or a brief
 * upstream outage, short enough that an operator watching the ledger after
 * writing a route learns the answer while still watching. Beyond that the
 * failure is not transient and a fourth attempt is a message nobody is waiting
 * for any more.
 */
export const MAX_ROUTE_ATTEMPTS = 3;
const ROUTE_RETRY_DELAYS_MS = [60_000, 240_000] as const;

/** How often the loop looks for a retry that has come due. */
export const RETRY_TICK_MS = 20_000;

/** What a matched target is, flattened out of its union for the ledger. */
interface ResolvedTarget {
  kind: "tool" | "agent";
  /** The tool's wire name, or the automation's id. */
  name: string;
  input?: Record<string, unknown>;
}

/** One outstanding attempt, indexed in memory and authoritative on disk. */
interface PendingAttempt {
  wsId: string;
  ref: NotificationRef;
  routeId: string;
  target: string;
  attempts: number;
  dueAt: number;
}

export interface RouteDispatcherDeps {
  /** Where the routes and the ceilings live. */
  workspaceStore: WorkspaceStore;
  /** The inbox for one workspace — the ledger's only writer. */
  storeFor: (wsId: string) => NotificationStore;
  /**
   * The unattended door. Injected rather than reached for so this module can
   * be driven without a runtime, and so the one thing it must not do — build
   * a router itself — is not even in scope here.
   */
  dispatch: (opts: UnattendedDispatchOptions) => Promise<UnattendedDispatchResult>;
  /**
   * Every workspace with an inbox, for the one-time resume scan.
   *
   * A function rather than the list, because the answer is only wanted once
   * and asking for it at construction would make building a dispatcher an I/O
   * operation.
   */
  workspaceIds: () => Promise<string[]>;
  /** Where `notification.delivered` / `notification.delivery_failed` go. */
  eventSink: EventSink;
  /** The clock. Defaults to `Date.now`; injectable so a retry bound is testable. */
  now?: () => number;
}

/**
 * Evaluates routes for new items and drives their retries.
 *
 * Owned by the notifications platform source alongside the poller, started in
 * the same factory and stopped in the same `source.stop()`, for the same
 * reason: a timer that outlives the runtime holding a tenant's connectors
 * keeps calling their tools.
 */
export class RouteDispatcher {
  readonly #deps: RouteDispatcherDeps;
  readonly #now: () => number;
  /**
   * Outstanding attempts, keyed by their ledger row's identity.
   *
   * A derived index, not the state: every entry corresponds to a `pending` row
   * on disk, and {@link resume} rebuilds it from those rows at boot. Holding it
   * in memory is what keeps the retry tick from re-reading every inbox in the
   * process every twenty seconds.
   */
  readonly #pending = new Map<string, PendingAttempt>();
  /**
   * One delivery at a time per workspace.
   *
   * The poller hands items over without waiting — it must, or one archived
   * Slack channel would spend a workspace's whole poll budget on a timeout —
   * so without this a sweep that pulled forty events through three routes
   * would start a hundred and twenty tool calls at once, against the tenant's
   * own edge limiter, on the same bucket the agent uses. Serialising per
   * workspace also makes "targets run in the order the route lists them" true
   * across items and not only within one.
   */
  readonly #chains = new Map<string, Promise<unknown>>();

  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(deps: RouteDispatcherDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Arm the retry tick and pick up whatever a previous process left unfinished.
   *
   * Idempotent; a stopped dispatcher stays stopped. The resume is fired and
   * not awaited: it is a scan of the filesystem and the tick that consumes its
   * result does not run for another interval, so making callers wait on it
   * would only delay the runtime's boot.
   */
  start(): void {
    if (this.#timer || this.#stopped) return;
    void this.resume();
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Rebuild the pending index from what is on disk. Public for tests;
   * {@link start} calls it.
   *
   * A row still marked `pending` is one whose attempt this process never
   * finished — its predecessor died between writing the row and recording an
   * outcome — so it is due now. Rows that reached any terminal outcome are
   * absent from the scan, which is what makes "nothing already delivered is
   * re-sent" a property of the data rather than of a guard here.
   */
  async resume(): Promise<void> {
    let wsIds: string[];
    try {
      wsIds = await this.#deps.workspaceIds();
    } catch (err) {
      log.warn(`[notifications] could not list workspaces to resume deliveries: ${errorText(err)}`);
      return;
    }
    for (const wsId of wsIds) this.#resumeWorkspace(wsId);
    if (this.#pending.size > 0) {
      log.info(`[notifications] resuming ${this.#pending.size} unfinished route deliveries`);
    }
  }

  /** Index one workspace's unfinished rows. A workspace that cannot be read is skipped. */
  #resumeWorkspace(wsId: string): void {
    let rows: ReturnType<NotificationStore["pendingDeliveries"]>;
    try {
      rows = this.#deps.storeFor(wsId).pendingDeliveries();
    } catch (err) {
      log.warn(`[notifications] could not scan for unfinished deliveries: ${errorText(err)}`, {
        wsId,
      });
      return;
    }
    for (const { item, row } of rows) {
      // Only a tool target is ever left pending; an agent target is written
      // terminal. A row that says otherwise came off an edited record and has
      // nothing this slice can do for it.
      if (row.kind !== "tool") continue;
      const due = row.nextAttemptAt ? Date.parse(row.nextAttemptAt) : this.#now();
      this.#pending.set(pendingKey(wsId, item, row), {
        wsId,
        ref: { source: item.source, eventId: item.envelope.eventId },
        routeId: row.routeId,
        target: row.target,
        attempts: row.attempts,
        dueAt: Number.isFinite(due) ? due : this.#now(),
      });
    }
  }

  /**
   * Evaluate every route against one newly stored item and deliver what
   * matches.
   *
   * Never throws and never rejects for a reason the caller can act on: the
   * poller calls this after a durable write, and an inbox that stopped filling
   * because a Slack channel was archived is the failure this whole design
   * exists to avoid.
   */
  async onItem(wsId: string, item: Notification): Promise<void> {
    await this.#enqueue(wsId, async () => {
      try {
        await this.#evaluate(wsId, item);
      } catch (err) {
        log.warn(`[notifications] route evaluation failed: ${errorText(err)}`, {
          wsId,
          source: item.source,
        });
      }
    });
  }

  /**
   * Run every retry that has come due. Public for tests; the timer calls it.
   *
   * The entry is taken out of the index before its attempt runs, and
   * {@link #attempt} puts a fresh one back if the row is still pending — so a
   * tick that lands while an attempt is in flight cannot schedule the same
   * target twice.
   */
  async sweepRetries(): Promise<void> {
    const now = this.#now();
    const due = [...this.#pending.values()].filter((entry) => entry.dueAt <= now);
    for (const entry of due) {
      if (this.#stopped) return;
      this.#pending.delete(pendingKeyOf(entry));
      await this.#enqueue(entry.wsId, async () => {
        try {
          await this.#retry(entry);
        } catch (err) {
          log.warn(`[notifications] route retry failed: ${errorText(err)}`, { wsId: entry.wsId });
        }
      });
    }
  }

  /**
   * Run `task` after everything already queued for this workspace.
   *
   * `then(task, task)` so one caller's rejection does not strand the writers
   * behind it, and the stored tail swallows settlement so nothing here is ever
   * an unhandled rejection. The entry is dropped when nobody queued behind it,
   * which keeps the map from holding one permanent promise per workspace for
   * the life of the process. Same shape as the workspace-record write chain,
   * and deliberately NOT that chain: a delivery can take a minute, and hook
   * reconciles must not queue behind somebody's Slack outage.
   */
  #enqueue<T>(wsId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.#chains.get(wsId) ?? Promise.resolve();
    const next = prior.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(wsId, tail);
    void tail.then(() => {
      if (this.#chains.get(wsId) === tail) this.#chains.delete(wsId);
    });
    return next;
  }

  // -- evaluation --------------------------------------------------------

  async #evaluate(wsId: string, item: Notification): Promise<void> {
    const ws = await this.#deps.workspaceStore.get(wsId);
    const routes = readNotificationsConfig(ws).routes ?? [];
    if (routes.length === 0) return;

    const matched = matchTargets(routes, item);
    if (matched.length === 0) return;

    const ref: NotificationRef = { source: item.source, eventId: item.envelope.eventId };
    // Every row is written BEFORE its attempt, so the work is on disk from the
    // moment it exists. A ledger the runtime could not write is a delivery
    // nobody could see and nothing could resume, so it stops here.
    const seeded = seedRows(matched, new Date(this.#now()).toISOString());
    if (!this.#writeLedger(wsId, ref, seeded)) return;

    for (const { target } of matched) {
      if (target.kind === "agent") {
        notificationsDeliveredTotal.inc({ kind: "agent", outcome: "deferred" });
      }
    }

    for (const { route, target } of matched) {
      if (this.#stopped) return;
      if (target.kind !== "tool") continue;
      await this.#attempt(wsId, item, ref, route, target, 0);
    }
  }

  // -- one target --------------------------------------------------------

  /**
   * Make one attempt at one tool target and record where it left the row.
   *
   * `priorAttempts` is what the ledger already counted, so the attempt being
   * made is `priorAttempts + 1` — which is what goes on the row whether it
   * succeeded or not. An operator reading "failed after 3 attempts" is reading
   * the number of times a tool was actually called.
   */
  async #attempt(
    wsId: string,
    item: Notification,
    ref: NotificationRef,
    route: NotificationRoute,
    target: ResolvedTarget,
    priorAttempts: number,
  ): Promise<void> {
    const presentation = notificationPresentation(item.envelope);
    const rendered = renderDeliverInput(target.input, presentation);
    if (rendered.misses > 0) {
      notificationsTemplateMissesTotal.inc(rendered.misses);
      log.warn(
        `[notifications] route "${route.id}" template used ${rendered.misses} placeholder(s) ` +
          "this runtime does not resolve; they were rendered empty",
        { wsId, source: item.source },
      );
    }

    const attempts = priorAttempts + 1;
    let result: UnattendedDispatchResult;
    try {
      result = await this.#deps.dispatch({
        principalId: route.createdBy,
        workspaceId: wsId,
        tool: target.name,
        input: rendered.input,
        // Opaque to the door and stamped on the outbound call's `_meta`, so a
        // server can tell a routed call from an interactive one.
        reason: `route:${route.id}`,
      });
    } catch (err) {
      // The door's contract is that nothing leaves it as an exception. If one
      // does anyway, it is the same shape as a call that did not complete.
      result = { outcome: "error", classification: "tool_error", error: errorText(err) };
    }

    await this.#reconcileAuthorState(wsId, route, result);

    const outcome = ledgerOutcome(result, attempts);
    const at = new Date(this.#now()).toISOString();
    const row: DeliveryRecord = {
      routeId: route.id,
      target: target.name,
      kind: "tool",
      attempts,
      outcome,
      updatedAt: at,
      ...(result.classification ? { classification: result.classification } : {}),
      ...(result.error ? { lastError: truncateError(result.error) } : {}),
      ...(outcome === "pending"
        ? { nextAttemptAt: new Date(this.#now() + retryDelayMs(attempts)).toISOString() }
        : {}),
    };
    this.#writeLedger(wsId, ref, [row]);

    if (outcome === "pending") {
      const entry: PendingAttempt = {
        wsId,
        ref,
        routeId: route.id,
        target: target.name,
        attempts,
        dueAt: this.#now() + retryDelayMs(attempts),
      };
      this.#pending.set(pendingKeyOf(entry), entry);
      return;
    }

    notificationsDeliveredTotal.inc({ kind: "tool", outcome });
    this.#emitOutcome(wsId, item, row);
  }

  /** Re-run one target that a previous attempt left pending. */
  async #retry(entry: PendingAttempt): Promise<void> {
    const store = this.#deps.storeFor(entry.wsId);
    const item = store.get(entry.ref.source, entry.ref.eventId);
    if (!item) {
      // Pruned out from under the retry, or the workspace is gone. There is
      // nothing to deliver and nowhere to write that down.
      return;
    }
    const ws = await this.#deps.workspaceStore.get(entry.wsId);
    const route = readNotificationsConfig(ws).routes?.find((r) => r.id === entry.routeId);
    if (!route) {
      // The route was rewritten or deleted between attempts. Stop rather than
      // firing a target the current configuration does not name — the stored
      // rule is the authority on every attempt, not just the first.
      this.#closeAbandoned(entry, item, "the route was changed or removed before the retry ran");
      return;
    }
    const target = route.deliver
      .map(resolveTarget)
      .find((candidate) => candidate.kind === "tool" && candidate.name === entry.target);
    if (!target) {
      this.#closeAbandoned(entry, item, "the route no longer delivers to this target");
      return;
    }

    await this.#attempt(entry.wsId, item, entry.ref, route, target, entry.attempts);
  }

  /**
   * Close out a pending row whose route no longer exists, so it does not sit
   * pending forever and does not resume on the next boot.
   */
  #closeAbandoned(entry: PendingAttempt, item: Notification, reason: string): void {
    const row: DeliveryRecord = {
      routeId: entry.routeId,
      target: entry.target,
      kind: "tool",
      attempts: entry.attempts,
      outcome: "failed",
      classification: "route_changed",
      lastError: reason,
      updatedAt: new Date(this.#now()).toISOString(),
    };
    this.#writeLedger(entry.wsId, entry.ref, [row]);
    notificationsDeliveredTotal.inc({ kind: "tool", outcome: "failed" });
    this.#emitOutcome(entry.wsId, item, row);
  }

  // -- the author's membership -------------------------------------------

  /**
   * Keep the route's dormancy note in step with what the dispatch just found.
   *
   * The dispatch answers the membership question on every call, so this is a
   * read of an answer rather than a second check: a `skipped/owner_not_member`
   * sets the note, and any other outcome means the author was a member and
   * clears it. That is what makes a route self-heal on re-add without anybody
   * touching the settings page — the same semantics a scheduled run has.
   */
  async #reconcileAuthorState(
    wsId: string,
    route: NotificationRoute,
    result: UnattendedDispatchResult,
  ): Promise<void> {
    const notMember = result.classification === "owner_not_member";
    try {
      if (notMember) {
        await setRouteDisabled(this.#deps.workspaceStore, wsId, route.id, {
          reason:
            `Its author is no longer a member of this workspace, so nothing dispatches. ` +
            "Re-adding them turns it back on; changing the author means saving the route again.",
          at: new Date(this.#now()).toISOString(),
        });
      } else if (route.disabled) {
        await setRouteDisabled(this.#deps.workspaceStore, wsId, route.id, null);
      }
    } catch (err) {
      // The note is a report. Failing to write it must not change what the
      // delivery did or stop the targets behind it.
      log.warn(`[notifications] could not update route state: ${errorText(err)}`, {
        wsId,
        source: route.id,
      });
    }
  }

  // -- the ledger --------------------------------------------------------

  /** Write rows, reporting whether they landed. Never throws. */
  #writeLedger(wsId: string, ref: NotificationRef, rows: readonly DeliveryRecord[]): boolean {
    try {
      return this.#deps.storeFor(wsId).recordDeliveries(ref, rows) !== undefined;
    } catch (err) {
      // A ledger the runtime could not write is a delivery nobody can see,
      // which is bad; a route that stopped because of it would be worse.
      log.warn(`[notifications] ledger write failed: ${errorText(err)}`, {
        wsId,
        source: ref.source,
      });
      return false;
    }
  }

  #emitOutcome(wsId: string, item: Notification, row: DeliveryRecord): void {
    const base = {
      workspaceId: wsId,
      id: notificationId(item),
      seq: item.seq,
      routeId: row.routeId,
      target: row.target,
      attempts: row.attempts,
    };
    try {
      if (row.outcome === "delivered") {
        this.#deps.eventSink.emit({ type: "notification.delivered", data: base });
        return;
      }
      if (row.outcome === "deferred") return;
      this.#deps.eventSink.emit({
        type: "notification.delivery_failed",
        data: {
          ...base,
          outcome: row.outcome,
          ...(row.classification ? { classification: row.classification } : {}),
          ...(row.lastError ? { error: row.lastError } : {}),
        },
      });
    } catch (err) {
      log.warn(`[notifications] delivery event not emitted: ${errorText(err)}`, { wsId });
    }
  }

  // -- the tick ----------------------------------------------------------

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.sweepRetries().finally(() => {
        this.#timer = null;
        this.#schedule();
      });
    }, RETRY_TICK_MS);
  }
}

// -- pure helpers ----------------------------------------------------------

/** One target a route pointed at this item. */
interface MatchedTarget {
  route: NotificationRoute;
  target: ResolvedTarget;
}

/**
 * Every `(route, target)` pair one item matched, in the order the workspace
 * lists them — routes in array order, and each route's targets in its own.
 *
 * Routes are independent: one that matches has no bearing on whether the next
 * one does, so this is a filter over the list and never a first-match.
 */
function matchTargets(routes: readonly NotificationRoute[], item: Notification): MatchedTarget[] {
  const level = notificationEffectiveLevel(item);
  const out: MatchedTarget[] = [];
  for (const route of routes) {
    if (!routeMatches(route, item, level)) continue;
    notificationsRoutesMatchedTotal.inc({ source: notificationSourceLabel(item.source) });
    for (const target of route.deliver) out.push({ route, target: resolveTarget(target) });
  }
  return out;
}

/**
 * The ledger rows a match produces, before anything has been attempted.
 *
 * A tool target starts `pending` and due now; an agent target is written
 * terminal in the same pass, because this slice's whole contribution to it is
 * recording that it matched. Both carry `updatedAt` from one instant, so the
 * rows for one item share a timestamp rather than drifting across the loop.
 */
function seedRows(matched: readonly MatchedTarget[], at: string): DeliveryRecord[] {
  return matched.map(({ route, target }) =>
    target.kind === "agent"
      ? {
          routeId: route.id,
          target: target.name,
          kind: "agent",
          attempts: 0,
          outcome: "deferred",
          classification: "awaiting_wake",
          updatedAt: at,
        }
      : {
          routeId: route.id,
          target: target.name,
          kind: "tool",
          attempts: 0,
          outcome: "pending",
          updatedAt: at,
          nextAttemptAt: at,
        },
  );
}

/**
 * Whether one route's `match` admits one item, at the level routes see it at.
 *
 * `source` is exact, `name` is a glob, `level` is a minimum. All three are
 * optional and an omitted one narrows nothing, so an empty match is every
 * notification the workspace receives — legal, and the schema says so.
 */
export function routeMatches(
  route: NotificationRoute,
  item: Pick<Notification, "source"> & { envelope: { name: string } },
  effectiveLevel: keyof typeof NOTIFICATION_LEVEL_RANK,
): boolean {
  const match = route.match ?? {};
  if (match.source !== undefined && match.source !== item.source) return false;
  if (!matchesNameGlob(item.envelope.name, match.name)) return false;
  if (
    match.level !== undefined &&
    NOTIFICATION_LEVEL_RANK[effectiveLevel] < NOTIFICATION_LEVEL_RANK[match.level]
  ) {
    return false;
  }
  return true;
}

/** Flatten a stored target's union into the shape the ledger and the call need. */
function resolveTarget(target: NotificationDeliverTarget): ResolvedTarget {
  return target.kind === "agent"
    ? { kind: "agent", name: target.automation }
    : { kind: "tool", name: target.tool, ...(target.input ? { input: target.input } : {}) };
}

/**
 * Where one dispatch result leaves the row.
 *
 * The retry decision is the door's, read rather than re-derived: `denied` is a
 * gate's refusal and retrying changes nothing until configuration does;
 * `skipped` is a dormant author, which comes back on its own; `error` is a
 * call that did not complete and is worth a retry until the budget runs out.
 */
function ledgerOutcome(result: UnattendedDispatchResult, attempts: number): DeliveryOutcome {
  switch (result.outcome) {
    case "ok":
      return "delivered";
    case "denied":
      return "denied";
    case "skipped":
      return "skipped";
    default:
      return attempts >= MAX_ROUTE_ATTEMPTS ? "failed" : "pending";
  }
}

/**
 * How long to wait before attempt `attempts + 1`.
 *
 * The ladder is this slice's; the indexing is the scheduler's, reused rather
 * than rewritten. The delays are not: an automation backs off toward an hour
 * because a failing schedule should be asked less and less often, while a
 * notification that has not been delivered in five minutes is one nobody is
 * still waiting for.
 */
function retryDelayMs(attempts: number): number {
  return backoffDelay(attempts, ROUTE_RETRY_DELAYS_MS);
}

/** Ledger rows cross to the browser; a tool's error text does not set the size. */
function truncateError(message: string): string {
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The identity of one ledger row, across a restart. */
function pendingKey(wsId: string, item: Notification, row: DeliveryRecord): string {
  return JSON.stringify([wsId, item.source, item.envelope.eventId, row.routeId, row.target]);
}

function pendingKeyOf(entry: PendingAttempt): string {
  return JSON.stringify([
    entry.wsId,
    entry.ref.source,
    entry.ref.eventId,
    entry.routeId,
    entry.target,
  ]);
}
