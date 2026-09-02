/**
 * Inbound delivery URLs, for the workspace settings surface.
 *
 * A connector that declares an inbound stream is minted a URL, and that URL is
 * an ADDRESS: a workspace admin has to be able to read it, hand it to another
 * system, and replace it when it leaks. Nothing surfaced that; the URLs existed
 * only in the runtime's records and in whatever the vendor was told.
 *
 * **Both tools are INTERNAL.** They are stripped from every LLM listing — chat
 * and `/mcp` alike — while staying callable by name, so the settings UI reaches
 * them and no agent does. That is the whole reason for the annotation here: the
 * URL is a capability, and an agent that could read one could put it in a
 * message, a file, or an outbound email, handing a working capability to
 * whoever received it. An admin reading it off their own screen is a different
 * act from an agent that can pass it on.
 *
 * **Both require workspace admin**, by the strict rule
 * `canWriteWorkspaceScoped` already enforces for the instructions overlay: an
 * org role grants no bypass. Reading is gated as tightly as rotating because
 * reading is what discloses the capability; rotating only replaces it.
 */

import { type EventSink, INTERNAL_TOOL_ANNOTATION, type ToolResult } from "../../engine/types.ts";

import { ensureHooks } from "../../hooks/reconcile.ts";
import { isPreviousStillValid, listRegistrations } from "../../hooks/registrations.ts";
import { buildHookUrl } from "../../hooks/token.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { canWriteWorkspaceScoped } from "../../workspace/authz.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { HooksListInput, HooksRotateInput } from "./schemas/hooks.ts";

/** Source name — keep stable; the settings UI calls `hooks__list_webhooks`. */
export const HOOKS_SOURCE_NAME = "hooks";

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function refuse(message: string): ToolResult {
  // Human text in `content`: the web tier's parseToolResult throws
  // `new Error(content[0].text)`, so whatever is here is what the admin reads.
  return { content: textContent(message), structuredContent: { error: message }, isError: true };
}

/**
 * The workspace this call is for, and whether the caller may see its URLs.
 *
 * Returns the id rather than taking one: a caller that could name a workspace
 * could read another's delivery URLs by naming it, and the authorization below
 * would be answering about the wrong record.
 */
async function adminWorkspace(
  runtime: Runtime,
): Promise<{ ok: true; wsId: string } | { ok: false; reason: string }> {
  const wsId = runtime.getCurrentWorkspaceId();
  if (!wsId) return { ok: false, reason: "No active workspace" };
  const identity = runtime.getCurrentIdentity();
  if (!identity) return { ok: false, reason: "No authenticated identity" };
  const ws = await runtime.getWorkspaceStore().get(wsId);
  const decision = canWriteWorkspaceScoped(identity, ws);
  return decision.allowed
    ? { ok: true, wsId }
    : {
        ok: false,
        reason:
          decision.reason ??
          "A delivery URL is a capability: whoever holds it may submit deliveries for " +
            "this workspace. Only a workspace admin may read or replace one.",
      };
}

/** Whether this workspace actually holds the stream a rotation names. */
async function holdsStream(
  runtime: Runtime,
  wsId: string,
  connector: string,
  vendor: string,
): Promise<boolean> {
  const ws = await runtime.getWorkspaceStore().get(wsId);
  return listRegistrations(ws ?? {}).some((r) => r.connector === connector && r.vendor === vendor);
}

/**
 * Mint a replacement URL and hand it to the connector.
 *
 * The record is re-read afterwards rather than inferred from the reconcile's
 * return: the URL reported here has to be the one the door will admit, and the
 * store is the only thing that knows that.
 */
async function rotate(
  runtime: Runtime,
  wsId: string,
  connector: string,
  vendor: string,
): Promise<ToolResult> {
  const provisioned = await ensureHooks(runtime.getHookReconcileDeps(), wsId, connector, {
    rotate: true,
    onlyVendor: vendor,
  });
  const outcome = provisioned.find((p) => p.vendor === vendor);
  if (!outcome) {
    // Nothing was minted, so nothing rotated. Reporting the re-read record here
    // would hand back the CURRENT url as though it were the new one — and this
    // control is reached when a URL has leaked, which is the worst moment to be
    // told a rotation happened that did not.
    return refuse(
      `Nothing was rotated. "${connector}" declares no inbound hook for "${vendor}", or its ` +
        "connection is not running — the new URL has to be handed to the server, so it can " +
        "only be rotated while that server is reachable. The existing URL is unchanged and " +
        "still live. Start the connector and try again.",
    );
  }

  const after = await runtime.getWorkspaceStore().get(wsId);
  const rotated = listRegistrations(after ?? {}).find(
    (r) => r.connector === connector && r.vendor === vendor,
  );

  return {
    content: textContent(
      JSON.stringify({
        connector,
        vendor,
        url: rotated ? buildHookUrl(rotated.deliveryId) : null,
        // Whether the CONNECTOR took the new URL. False is the recoverable case
        // and has to be said: the URL is minted and the door admits it, but the
        // vendor is still delivering to the old one, which the grace window is
        // holding open.
        registered: outcome.registered,
        error: outcome.error ?? null,
        previousStillValid: rotated ? isPreviousStillValid(rotated) : false,
      }),
    ),
    isError: false,
  };
}

export function createHooksSource(runtime: Runtime, eventSink: EventSink): McpSource {
  const tools: InProcessTool[] = [
    {
      name: "list_webhooks",
      description:
        "Every inbound delivery URL this workspace holds, with the address itself, " +
        "which connector and vendor it is for, when it was created and last rotated. " +
        "Workspace admin only. Read-only.",
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: HooksListInput,
      handler: async (): Promise<ToolResult> => {
        const auth = await adminWorkspace(runtime);
        if (!auth.ok) return refuse(auth.reason);

        const ws = await runtime.getWorkspaceStore().get(auth.wsId);
        const webhooks = listRegistrations(ws ?? {}).map((reg) => ({
          connector: reg.connector,
          vendor: reg.vendor,
          route: reg.route,
          // The address, in full. Rebuilt from the stored id rather than kept
          // as a second copy, so there is one thing to rotate and no way for a
          // displayed URL to disagree with the one the door admits.
          url: buildHookUrl(reg.deliveryId),
          createdAt: reg.createdAt,
          rotatedAt: reg.rotatedAt ?? null,
          // True while the previous URL still opens. An operator mid-rotation
          // needs to know the old one has not stopped working yet, because that
          // is exactly when re-registering at the vendor is still safe to defer.
          previousStillValid: isPreviousStillValid(reg),
        }));

        return {
          content: textContent(JSON.stringify({ webhooks, count: webhooks.length })),
          isError: false,
        };
      },
    },
    {
      name: "rotate_webhook",
      description:
        "Replace one stream's delivery URL and hand the new one to the connector, " +
        "which re-registers it with the vendor. The previous URL keeps working for a " +
        "grace window so deliveries already in flight are not lost. Requires `confirm` " +
        "to equal the vendor slug. Workspace admin only.",
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: HooksRotateInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const auth = await adminWorkspace(runtime);
        if (!auth.ok) return refuse(auth.reason);

        const connector = String(input.connector ?? "");
        const vendor = String(input.vendor ?? "");
        // Typed rather than clicked. A rotation starts a clock on the URL the
        // vendor is delivering to right now, and naming the stream is what makes
        // that a decision instead of a reflex.
        if (String(input.confirm ?? "") !== vendor) {
          return refuse(
            `To rotate the ${vendor} stream, set "confirm" to "${vendor}". The current URL ` +
              "stops working once its grace window closes, and the connector must " +
              "re-register the new one with the vendor.",
          );
        }
        if (!(await holdsStream(runtime, auth.wsId, connector, vendor))) {
          return refuse(
            `This workspace holds no ${vendor} stream for ${connector}. list_webhooks ` +
              "shows what it does hold.",
          );
        }
        return rotate(runtime, auth.wsId, connector, vendor);
      },
    },
  ];

  return defineInProcessApp(
    {
      name: HOOKS_SOURCE_NAME,
      version: "0.1.0",
      tools,
    },
    eventSink,
  );
}
