/**
 * The unattended single dispatch — the third door.
 *
 * The other two both establish a principal from something the caller PROVED:
 * a chat or task session carries an authenticated identity and a
 * membership-validated workspace (`IdentityToolRouter`), and a `/mcp` request
 * carries a validated `X-Workspace-Id` (`McpServerHost.handlePost`). This one
 * takes its principal from **stored configuration** — a user id an admin's
 * write stamped, read back later with nobody present. That is the whole of
 * what is new, and it is why the door is a primitive rather than a call site:
 * the gates a session gets for free have to be applied deliberately here, in
 * one place, once.
 *
 * It makes ONE tool call. There is no loop, no model, no conversation, no run
 * record. The result goes back to the caller and nowhere else.
 *
 * In order:
 *
 *   1. **Membership**, the check a scheduled run performs (ADR-0007: to *act*
 *      in a workspace you must be a *current* member; ownership is not enough).
 *      A non-member is `skipped`, not denied — the same classification and the
 *      same self-healing-on-re-add semantics a scheduled run gets, and it
 *      happens before the registry is touched at all.
 *   2. **The name**, against the unattended policy — the authoring surfaces
 *      whose effect would outlive the call (`src/tools/unattended-policy.ts`).
 *   3. **The router**, built for `(principalId, workspaceId)` exactly as a
 *      session builds it, so the wall (ADR-0005), `assertToolAllowed`, the
 *      personal-connector grant (ADR-0006) and `INTERNAL_TOOL_ANNOTATION`
 *      semantics all apply by being the same code, not by being re-stated.
 *   4. **Bounds** — a wall-clock timeout that actually cancels the in-flight
 *      call, and a cap on how large a result may come back.
 *   5. **The audit line**, one `audit.unattended_dispatch` per call whatever
 *      the outcome. A dispatch leaves no transcript and no run result, so this
 *      is the only trace it has.
 *
 * **Nothing throws out.** Every refusal and every failure comes back as an
 * outcome with a classification, because the caller is a background loop with
 * no user to show an exception to, and a throw would end its sweep.
 *
 * The classification is READ OFF the door's own structured errors rather than
 * re-derived: `IdentityToolRouter` already renders every orchestrator refusal
 * as `structuredContent.error === "orchestrator_error"` with a `reason`
 * discriminator, and `assertToolAllowed` renders its own. A second taxonomy
 * here would be a copy that drifts from the door it describes.
 */

import type { EventSink, ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { IdentityToolRouter } from "../runtime/identity-tool-router.ts";
import { runWithRequestContext } from "../runtime/request-context.ts";
import { isUnattendedForbiddenTool } from "../tools/unattended-policy.ts";
import type { OrchestratorRuntime } from "./route.ts";

/**
 * Wall-clock ceiling on one dispatch, matching the stock MCP request timeout
 * an inline tool call already runs under — so the door adds a bound it can
 * enforce (it cancels), not a second, different deadline.
 */
export const UNATTENDED_DISPATCH_TIMEOUT_MS = 60_000;

/**
 * Ceiling on a serialized result, in bytes. Same figure as the notification
 * envelope's payload cap, for the same reason: a caller reading an opaque
 * result from a server it does not control must not let that server decide how
 * much memory the read costs. Over the cap the result is dropped, not
 * truncated — half a JSON document is worse than none.
 */
export const UNATTENDED_RESULT_MAX_BYTES = 64 * 1024;

/** Ceiling on the caller's `reason`, which is echoed into the audit line. */
export const UNATTENDED_REASON_MAX = 200;

export interface UnattendedDispatchOptions {
  /**
   * The user the call runs as. Comes from in-process configuration an
   * authenticated write stamped — NEVER from a request body, and never a
   * configurable "act as": naming someone else would be impersonation.
   */
  principalId: string;
  /** The one workspace the call is walled to. */
  workspaceId: string;
  /** Bare `<source>__<tool>` wire name, the only form either door accepts. */
  tool: string;
  input: Record<string, unknown>;
  /**
   * The caller's own short string saying what fired this (`"route:rt_…"`).
   * Opaque here: it is echoed into the audit line and stamped on the outbound
   * call's `_meta`, and nothing parses it. Truncated at
   * {@link UNATTENDED_REASON_MAX}.
   */
  reason: string;
  /** Override the {@link UNATTENDED_DISPATCH_TIMEOUT_MS} default. */
  timeoutMs?: number;
  /** Override the {@link UNATTENDED_RESULT_MAX_BYTES} default. */
  maxResultBytes?: number;
}

export type UnattendedDispatchOutcome = "ok" | "denied" | "skipped" | "error";

/**
 * Why, for every outcome but `ok`.
 *
 * The `denied` set is "a gate refused": the principal may not do this, and
 * retrying changes nothing until configuration does. The `error` set is "the
 * call did not complete": a source that is down or absent, a tool that failed,
 * a bound that was hit — all of which a caller may reasonably retry.
 * `unknown_tool_source` sits on the error side deliberately, because it also
 * means "installed but transiently absent" (see `resolveWorkspaceSource`).
 */
export type UnattendedDispatchClassification =
  // skipped
  | "owner_not_member"
  // denied
  | "tool_not_allowed"
  | "invalid_tool_name"
  | "workspace_access_denied"
  | "connector_grant_denied"
  | "tool_permission_denied"
  // error
  | "unknown_tool_source"
  | "unknown_identity_source"
  | "tool_error"
  | "timeout"
  | "result_too_large";

export interface UnattendedDispatchResult {
  outcome: UnattendedDispatchOutcome;
  /** The tool's own result, on `ok` and on `tool_error`. Absent otherwise. */
  result?: ToolResult;
  /** Human-readable detail for a non-`ok` outcome. */
  error?: string;
  /** Absent exactly when `outcome` is `ok`. */
  classification?: UnattendedDispatchClassification;
}

/**
 * What the door needs beyond `routeToolCall`'s own surface: the membership
 * check, and somewhere to put the audit line.
 */
export interface UnattendedDispatchRuntime extends OrchestratorRuntime {
  /**
   * True if `principalId` may CURRENTLY act in `wsId`. The production `Runtime`
   * satisfies this with the same method behind the conversation-resume gate and
   * the scheduled-run gate, so all three answer one question one way.
   */
  isPrincipalWorkspaceMember(wsId: string, principalId: string): Promise<boolean>;
  /** Where the `audit.unattended_dispatch` line goes. */
  getEventSink(): EventSink;
}

/**
 * Map the door's structured refusals onto this door's outcomes. Keyed on the
 * `reason` discriminator `mapOrchestratorErrorToToolResult` emits and on
 * `assertToolAllowed`'s own `tool_permission_denied` — never on message text.
 */
const CLASSIFICATION_BY_REASON: Readonly<
  Record<string, { outcome: UnattendedDispatchOutcome; as: UnattendedDispatchClassification }>
> = {
  invalid_tool_name: { outcome: "denied", as: "invalid_tool_name" },
  workspace_access_denied: { outcome: "denied", as: "workspace_access_denied" },
  connector_grant_denied: { outcome: "denied", as: "connector_grant_denied" },
  unknown_tool_source: { outcome: "error", as: "unknown_tool_source" },
  unknown_identity_source: { outcome: "error", as: "unknown_identity_source" },
};

/**
 * Dispatch one tool call, unattended, as `principalId`, through the gates a
 * session applies. See the module doc for the order and the invariants.
 */
export async function dispatchUnattended(
  runtime: UnattendedDispatchRuntime,
  opts: UnattendedDispatchOptions,
): Promise<UnattendedDispatchResult> {
  const startedAt = Date.now();
  const reason = opts.reason.slice(0, UNATTENDED_REASON_MAX);
  const audit = (res: UnattendedDispatchResult): UnattendedDispatchResult => {
    try {
      runtime.getEventSink().emit({
        type: "audit.unattended_dispatch",
        data: {
          principalId: opts.principalId,
          workspaceId: opts.workspaceId,
          tool: opts.tool,
          reason,
          outcome: res.outcome,
          ...(res.classification !== undefined ? { classification: res.classification } : {}),
          ms: Date.now() - startedAt,
        },
      });
    } catch {
      // `MultiEventSink` fans out without a per-sink guard, so one sink throwing
      // would leave this function by the one path it promises never to take.
      // A lost audit line is worse than nothing and better than a sweep that
      // stops; the sinks that matter here log their own write failures.
    }
    return res;
  };

  // Gate 1 — membership, before the registry is touched. A principal who has
  // left the workspace is SKIPPED: the configuration that named them is not
  // wrong, it is dormant, and it comes back to life if they are re-added.
  if (!(await runtime.isPrincipalWorkspaceMember(opts.workspaceId, opts.principalId))) {
    return audit({
      outcome: "skipped",
      classification: "owner_not_member",
      error: `principal "${opts.principalId}" is not a member of workspace "${opts.workspaceId}"`,
    });
  }

  // Gate 2 — the name. Checked before routing so the answer is the policy's,
  // not a source-specific error raised three layers down once the tool has
  // already been resolved.
  if (isUnattendedForbiddenTool(opts.tool)) {
    return audit({
      outcome: "denied",
      classification: "tool_not_allowed",
      error: `tool "${opts.tool}" is not available to an unattended dispatch`,
    });
  }

  const timeoutMs = opts.timeoutMs ?? UNATTENDED_DISPATCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Abort AND race. The abort is what stops the work — `McpSource` forwards the
  // signal to the SDK, which cancels the in-flight RPC, in-process and remote
  // alike. The race is what bounds the CALLER: a source is free to ignore the
  // signal, and one that honours it still cannot promise when it returns. A
  // background sweep that blocks on a single tool is the failure this exists to
  // prevent, and only the race prevents it.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`dispatch of "${opts.tool}" exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });

  let result: ToolResult;
  try {
    // Constructed inside the `try` with the dispatch it serves: it validates its
    // own arguments and throws, and this function's contract is that nothing
    // leaves it as an exception.
    const router = new IdentityToolRouter({
      identityId: opts.principalId,
      workspaceId: opts.workspaceId,
      runtime,
    });
    const dispatched = runWithRequestContext(
      {
        // The same partial identity a scheduled run carries (`{ id: ownerId }`):
        // this door holds a principal ID, not an authenticated session, so there
        // is no `orgRole` to state and inventing one would be a claim nobody
        // made. Every org-admin gate reads that field and fails closed without
        // it, which is the right authority for a call nobody is watching.
        identity: { id: opts.principalId } as UserIdentity,
        workspaceId: opts.workspaceId,
        // Bars the automation-authoring surface at the sources themselves, so
        // the wall holds below anything this door checks by name.
        unattended: true,
        unattendedReason: reason,
      },
      () =>
        router.execute(
          { id: `unatt_${crypto.randomUUID().slice(0, 12)}`, name: opts.tool, input: opts.input },
          controller.signal,
        ),
    );
    // The loser of the race is still running. Swallow its eventual rejection so
    // a tool that throws after the deadline does not surface as an unhandled
    // rejection in a process that has already moved on.
    dispatched.catch(() => {});
    result = await Promise.race([dispatched, deadline]);
  } catch (err) {
    // `IdentityToolRouter` renders every routing refusal as a result, so a
    // throw here came out of the tool itself, the deadline, or the router's own
    // argument validation. The caller is a background loop: it gets an outcome,
    // never an exception.
    return audit({
      outcome: "error",
      classification: timedOut ? "timeout" : "tool_error",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const maxBytes = opts.maxResultBytes ?? UNATTENDED_RESULT_MAX_BYTES;
  const size = serializedSize(result);
  if (size > maxBytes) {
    return audit({
      outcome: "error",
      classification: "result_too_large",
      error: `result from "${opts.tool}" is ${size} bytes, over the ${maxBytes}-byte cap`,
    });
  }

  return audit(classify(result));
}

/**
 * Turn what came back into an outcome, reading the door's OWN structured
 * errors — `mapOrchestratorErrorToToolResult`'s `reason` discriminator and
 * `assertToolAllowed`'s `tool_permission_denied` — never the message text.
 */
function classify(result: ToolResult): UnattendedDispatchResult {
  if (!result.isError) return { outcome: "ok", result };

  const mapped = CLASSIFICATION_BY_REASON[refusalReason(result) ?? ""];
  if (mapped) {
    return { outcome: mapped.outcome, classification: mapped.as, error: resultText(result) };
  }
  if (result.structuredContent?.error === "tool_permission_denied") {
    return {
      outcome: "denied",
      classification: "tool_permission_denied",
      error: resultText(result),
    };
  }
  // The tool ran and reported failure. The result rides along: a caller
  // deciding whether to retry needs what the tool actually said.
  return { outcome: "error", classification: "tool_error", error: resultText(result), result };
}

/** The orchestrator refusal discriminator on an error result, if it is one. */
function refusalReason(result: ToolResult): string | undefined {
  const sc = result.structuredContent;
  if (sc?.error !== "orchestrator_error") return undefined;
  return typeof sc.reason === "string" ? sc.reason : undefined;
}

/** Flatten a result's text blocks into one line for the `error` field. */
function resultText(result: ToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join(" ")
    .trim();
}

/**
 * Serialized byte length of a result, or `Infinity` when it cannot be
 * serialized at all — a cycle or a BigInt from an in-process tool. Unmeasurable
 * is over the cap: the point of the bound is that the caller never holds
 * something it did not agree to hold.
 */
function serializedSize(result: ToolResult): number {
  try {
    return Buffer.byteLength(JSON.stringify(result) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
