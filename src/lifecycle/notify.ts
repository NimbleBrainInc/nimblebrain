import type { ToolResult } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import {
  type ConnectorPort,
  summarizeToolError,
  watchToolSurface,
} from "../tools/connector-surface.ts";
import { LifecycleContractError, verifyLifecycleTools } from "./declaration.ts";
import type { LifecycleDeclaration, LifecycleReadyReason } from "./types.ts";

/**
 * Telling a connector it is installed, and telling it that it is being removed.
 *
 * The trigger points are the hooks reconcile's — a fresh install, every
 * transition to `running`, and the connector's tool set becoming enumerable —
 * and the coalescing deliberately is **not**.
 *
 * > `singleFlight` in `src/hooks/reconcile.ts` exists to stop two concurrent
 * > mints diverging. `on_ready` mints nothing, so the flight would buy no
 * > safety and destroy the one thing `reason` carries: put the install call in
 * > the flight and a freshly-installed connector is told `"resume"`, or — once
 * > the dedupe set had recorded the observer's success — the install call is
 * > skipped entirely and the install notice goes with it.
 *
 * So the two triggers are separated. The install path calls
 * {@link notifyReady} with `reason: "install"` **ungated** — outside any
 * flight, outside {@link delivered}. The connection-running observer calls it
 * with `resume`, gated per `(workspace, connector)` per runtime process after
 * the first success.
 *
 * **A fresh install of an eager-started connector therefore delivers two
 * `on_ready` calls, in a racy order, and that is correct rather than
 * tolerated.** The contract is at-least-once, handlers are required to be
 * idempotent, and suppressing one would need the runtime to hold "an install is
 * in progress" state that does not exist.
 */

/** What a `on_ready` pass left behind. */
export interface ReadyOutcome {
  /**
   * Whether this pass finished: the declaration was checked and any `on_ready`
   * handler answered without an error.
   *
   * `false` means **defer** — the source is not up, or is up and advertises no
   * tools yet, or the handler failed. All three are answered the same way: try
   * again on the next transition or tool-surface change. It is what gates the
   * observer's dedupe, so a failed call is retried and a succeeded one is not.
   */
  settled: boolean;
  /**
   * The handler's text result — the bundle telling the user what is now
   * happening ("setting up your sending workspace — watch the panel").
   *
   * Distinct from a warning, and kept in its own field for that reason: a
   * warning says something is wrong, this says something is under way.
   */
  notice?: string;
}

export interface LifecycleNotifyDeps {
  /**
   * The lifecycle declaration for an installed connector, from
   * OPERATOR-TRUSTED metadata — the published catalog entry, never a
   * caller-supplied one. `undefined` when the connector declares none.
   */
  declarationFor(serverName: string): Promise<LifecycleDeclaration | undefined>;
  /** The live source for `(wsId, serverName)`, or undefined when it is not running. */
  portFor(wsId: string, serverName: string): ConnectorPort | undefined;
}

/**
 * Tell a connector it is ready, once.
 *
 * Silent no-op — not an error — when the connector declares no `lifecycle`
 * block, when its source is not running, or when that source advertises no
 * tools yet. All three are ordinary states rather than failures, and a
 * connector must install and work normally in every one of them.
 *
 * A {@link LifecycleContractError} propagates rather than being swallowed: a
 * declared handler that does not exist, or that cannot be called with no
 * arguments, is a manifest bug and the caller decides how loud it is. The
 * install path reports it as a warning on a successful install — it cannot
 * refuse an install that has already committed — and the connection-running
 * path logs it.
 *
 * **Both declared handlers are checked here, not only the one being called.**
 * An `on_removing` naming a tool that does not exist would otherwise surface at
 * uninstall, which is the one moment nobody is watching and the one moment a
 * retry does not come.
 */
export async function notifyReady(
  deps: LifecycleNotifyDeps,
  wsId: string,
  connector: string,
  reason: LifecycleReadyReason,
): Promise<ReadyOutcome> {
  const decl = await deps.declarationFor(connector);
  if (!decl) return { settled: true };

  const port = deps.portFor(wsId, connector);
  if (!port) {
    // The source is not up yet — an interactive-OAuth connector at install
    // time, or one still starting. Nothing has been said, so nothing is half
    // said; the same pass runs when the connection reaches `running`.
    log.debug("lifecycle", `[lifecycle] ${connector} declares lifecycle but is not running yet`);
    return { settled: false };
  }

  const tools = await port.tools();
  // An empty tool list is NOT a contract violation, and the difference is the
  // whole reason this branch exists. A violation says "this manifest is wrong,
  // no retry will help"; an empty list says the source is up but has not
  // advertised anything yet. Every declared name is absent from an empty list,
  // so checking one against it would accuse a manifest that is correct.
  if (tools.length === 0) {
    log.debug("lifecycle", `[lifecycle] ${connector} is running but advertises no tools yet`);
    return { settled: false };
  }
  verifyLifecycleTools(tools, decl, connector);

  const handler = decl.on_ready;
  // A server may declare `on_removing` alone. Its contract is checked above;
  // there is nothing to call now and nothing to come back for.
  if (!handler) return { settled: true };

  return callReady(port, connector, handler, reason);
}

/**
 * Call one `on_ready` handler.
 *
 * A failure here never fails the install and is never an error-level event: the
 * connector is installed and useful, and the next transition to `running`
 * retries. What the operator needs is to know the bundle was not told, which
 * the warn line gives them.
 */
async function callReady(
  port: ConnectorPort,
  connector: string,
  handler: string,
  reason: LifecycleReadyReason,
): Promise<ReadyOutcome> {
  let error: string;
  try {
    // `reason` travels whether or not the handler's schema declares it — see
    // `verifyLifecycleTools` for why that is deliberate and what it depends on.
    const result = await port.execute(handler, { reason });
    if (!result.isError) return { settled: true, ...noticeFrom(result.content) };
    error = summarizeToolError(result);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  log.warn("[lifecycle] on_ready handler did not accept the call", {
    connector,
    tool: handler,
    reason,
    error_reason: error,
  });
  return { settled: false };
}

/** Longest notice carried onto an install result. It comes off the wire. */
const NOTICE_MAX = 500;

/** The handler's own words, bounded, or nothing when it returned no text. */
function noticeFrom(content: ToolResult["content"] | undefined): { notice?: string } {
  const text = content?.find((c) => c.type === "text")?.text?.trim();
  return text ? { notice: text.slice(0, NOTICE_MAX) } : {};
}

/**
 * Connectors already told they are ready, per `(workspace, connector)`, for the
 * life of this runtime process.
 *
 * A **set of keys, not a timer** — the hooks reconcile has no clock and this
 * must not introduce one — and not a map of closures either: it holds strings,
 * so unlike an armed watch it cannot retain a source or the runtime that built
 * one. What it does need is {@link resetReadyNotifications} on shutdown, or a
 * process that starts a second runtime would suppress that runtime's boot
 * notification on the strength of the first one's.
 *
 * Per boot is the whole guarantee, and not per reconnect: this set suppresses a
 * later reconnect by design, and a source that reconnects through the source
 * alone records no connection state, so there is no second transition to fire
 * on either way.
 */
const delivered = new Set<string>();

function deliveredKey(wsId: string, connector: string): string {
  return `${wsId}|${connector}`;
}

/**
 * The connection-reached-running path: tell the connector it is ready with
 * `reason: "resume"`, at most once per process, and leave a way back for the
 * attempt that could not finish.
 *
 * The tool-surface watch is what covers a source whose tool list is not
 * populated at the moment `running` is observed — `running` is a one-shot, and
 * without the retrigger an attempt that deferred would have nothing to try
 * again.
 */
export function notifyReadyOnRunning(
  deps: LifecycleNotifyDeps,
  wsId: string,
  connector: string,
): void {
  watchToolSurface("lifecycle", wsId, connector, deps.portFor(wsId, connector), () =>
    resumeInBackground(deps, wsId, connector),
  );
  resumeInBackground(deps, wsId, connector);
}

/** Run the resume notification for its effect, reporting a failure rather than raising it. */
function resumeInBackground(deps: LifecycleNotifyDeps, wsId: string, connector: string): void {
  const key = deliveredKey(wsId, connector);
  if (delivered.has(key)) return;
  void notifyReady(deps, wsId, connector, "resume")
    .then((outcome) => {
      if (outcome.settled) delivered.add(key);
    })
    .catch((err) => {
      log.warn("[lifecycle] could not tell a running connector it is ready", {
        connector,
        workspace_id: wsId,
        reason: err instanceof Error ? err.message : String(err),
        contract_error: err instanceof LifecycleContractError,
      });
    });
}

/**
 * How long an uninstall waits for `on_removing` before proceeding without it.
 *
 * Short on purpose. The handler's job is to record the intent and return — the
 * contract says so in those words — and an admin is watching the uninstall.
 */
const REMOVING_DEADLINE_MS = 5_000;

/**
 * Tell a connector it is being removed, before anything is torn down.
 *
 * **Best-effort, never throws, and bounded.** A failure is a warn with the
 * connector named and the uninstall proceeds: blocking a user's uninstall on a
 * vendor's availability would be the wrong trade in both directions. A bundle
 * author must therefore not assume this call arrives — a bundle that leaks a
 * third-party resource when it does not is the failure this seam exists to
 * prevent, and hoping is not a design.
 *
 * **The deadline is what makes "best-effort" true rather than aspirational,
 * and it is held HERE rather than inferred from a check made elsewhere.**
 * Everything behind this call waits on it — the OAuth revoke, the source
 * teardown, the hook revoke, the secret deletion — so without a bound, the
 * duration of a workspace admin's uninstall is chosen by the connector being
 * removed. `verifyLifecycleTools` refuses a task-augmented handler, whose await
 * has no deadline of its own, but that check runs on the READY path and only
 * warns: it never gated this call, and it says nothing about a merely slow
 * inline one.
 *
 * Abandoning the call does not cancel the server's work; it stops the uninstall
 * waiting for it, which is all that was ever promised. `Promise.race` keeps a
 * reaction attached to the abandoned call, so a late rejection — the source
 * being torn down under it — is handled rather than surfacing as an unhandled
 * rejection.
 */
export async function notifyRemoving(
  deps: LifecycleNotifyDeps,
  wsId: string,
  connector: string,
  opts: { deadlineMs?: number } = {},
): Promise<void> {
  // Resolved before the call so the warn line can name the handler even when
  // what failed was reading the declaration or reaching the source.
  let handler: string | undefined;
  try {
    handler = (await deps.declarationFor(connector))?.on_removing;
    if (!handler) return;
    const port = deps.portFor(wsId, connector);
    if (!port) {
      log.debug(
        "lifecycle",
        `[lifecycle] ${connector} declares on_removing but is not running — skipping`,
      );
      return;
    }
    const result = await withDeadline(
      port.execute(handler, {}),
      opts.deadlineMs ?? REMOVING_DEADLINE_MS,
    );
    if (result === DEADLINE) {
      warnRemoving(
        connector,
        handler,
        `did not answer within ${opts.deadlineMs ?? REMOVING_DEADLINE_MS}ms`,
      );
      return;
    }
    if (!result.isError) return;
    warnRemoving(connector, handler, summarizeToolError(result));
  } catch (err) {
    warnRemoving(connector, handler, err instanceof Error ? err.message : String(err));
  }
}

/** What {@link withDeadline} returns when the call did not answer in time. */
const DEADLINE = Symbol("lifecycle-deadline");

/**
 * Resolve with the call's result, or with {@link DEADLINE} once `ms` has
 * passed — whichever comes first.
 *
 * The timer is cleared on both paths: a pending 5-second timer per uninstall
 * would keep a process alive past the work it belongs to.
 */
async function withDeadline(
  call: Promise<ToolResult>,
  ms: number,
): Promise<ToolResult | typeof DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), ms);
  });
  try {
    return await Promise.race([call, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function warnRemoving(connector: string, tool: string | undefined, error: string): void {
  log.warn("[lifecycle] on_removing was not delivered; the uninstall proceeds", {
    connector,
    ...(tool ? { tool } : {}),
    error_reason: error,
  });
}

/**
 * Forget a connector's ready notification. Called on uninstall, beside the hook
 * revoke: a reinstall is a new installation and must be told so, rather than
 * inheriting the suppression the previous one earned.
 */
export function forgetReadyNotification(wsId: string, connector: string): void {
  delivered.delete(deliveredKey(wsId, connector));
}

/**
 * Forget every ready notification. Called on runtime shutdown — see
 * {@link delivered} for why a second runtime in one process needs this.
 */
export function resetReadyNotifications(): void {
  delivered.clear();
}
