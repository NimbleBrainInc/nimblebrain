/**
 * Instructions platform source — in-process MCP server.
 *
 * Owns one cross-cutting overlay:
 *   instructions://workspace   (set via the workspace settings page)
 *
 * Plus a single write tool, `write_instructions(body)`, gated so that only a
 * workspace admin member may write — an org role grants no bypass.
 *
 * The write tool is INTERNAL (`ai.nimblebrain/internal`): the settings UI
 * invokes it by name over `/v1/tools/call`; the model never sees it. The
 * overlay is injected into every conversation's prompt, so its author is the
 * human, on a surface where they see the whole text they are replacing —
 * never the agent overwriting an 8 KiB prose blob to add one line. An agent
 * asked to persist standing guidance drafts the text and points the user at
 * workspace settings (see `bootstrap.md`); facts and state go to a memory
 * app where one is installed.
 *
 * There is no org-wide overlay. Org-scope standing guidance is an org-tier
 * **skill** (`{workDir}/skills/`, authored at `/org/skills`), which is
 * file-backed and org-admin-gated like this overlay was, and additionally
 * carries per-topic granularity, dynamic loading, and triggers — so org-wide
 * content that is only sometimes relevant costs nothing when it isn't.
 *
 * Per-bundle custom instructions are NOT in this module's scope. Bundles
 * publish a `app://instructions` resource if and only if they
 * support the convention; the runtime reads it on every prompt assembly
 * and wraps it in `<app-custom-instructions>` containment alongside the
 * bundle author's static `<app-instructions>`. Storage, UI, and the agent
 * tool to write/clear all live in the bundle.
 */

import { textContent } from "../../engine/content-helpers.ts";
import { type EventSink, INTERNAL_TOOL_ANNOTATION, type ToolResult } from "../../engine/types.ts";
import { getRequestContext } from "../../runtime/request-context.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { canWriteWorkspaceScoped } from "../../workspace/authz.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { InstructionsWriteInput } from "./schemas/instructions.ts";

// ── Tool description ─────────────────────────────────────────────────────
// UI-facing only: the tool is internal, so no model reads this. Kept accurate
// for the settings UI and for operators reading the wire.

const WRITE_INSTRUCTIONS_DESCRIPTION =
  "Save workspace-wide custom instructions, applied to every conversation in this workspace. " +
  "Internal: invoked by the workspace settings UI; not part of the agent's tool surface. " +
  "Empty text clears the instruction.";

// ── Permission helpers ───────────────────────────────────────────────────

/**
 * Allowed carries the validated workspace id, so the write site narrows from
 * the decision instead of asserting past it — the gate and the id it validated
 * travel together.
 */
type PermissionDecision = { allowed: true; wsId: string } | { allowed: false; reason: string };

async function checkWritePermission(
  runtime: Runtime,
  wsId: string | null,
): Promise<PermissionDecision> {
  // Unattended-run wall, checked before every other gate including dev mode.
  //
  // The write persists into every later conversation in the workspace, for
  // every member, so it belongs to a present human. An unattended run has no
  // human present, and is told so ("there is nobody available to confirm
  // choices — decide and proceed"), while routinely ingesting untrusted
  // content: email, web pages, tickets. A "from now on…" line in any of that
  // would otherwise reach a durable cross-conversation write with nothing
  // standing between them.
  //
  // Enforced HERE, at the source, for the reason `createAutomationsSource`
  // gives for the same wall: this is the single dispatch point every caller
  // funnels through, so it holds for the top-level run AND a delegated
  // sub-agent at any depth. The tool is internal and never reaches the model's
  // surface, so this is belt-and-braces rather than the primary barrier — it
  // costs one context read and closes the gap if the annotation is ever
  // dropped. `unattended` rides the ambient request context and survives the
  // per-call restamp.
  if (getRequestContext()?.unattended) {
    return {
      allowed: false,
      reason:
        "Instructions cannot be written from inside an unattended automation run — " +
        "they persist across every later conversation in the workspace and there is no one " +
        "present to confirm the change. Write them from an interactive session.",
    };
  }

  // No workspace, no overlay to write — checked ahead of the dev-mode
  // allow-through, which would otherwise return `allowed` with no wsId and
  // leave the write site's non-null assertion false (rescued only by
  // `resolveDir` throwing into the handler's catch).
  if (!wsId) {
    return { allowed: false, reason: "Writing instructions requires a workspace context" };
  }

  // Dev mode (no identity provider configured) — allow writes through.
  // Matches the existing convention for dev-mode tool dispatch (see
  // `src/runtime/runtime.ts:getCurrentIdentity` — null in dev).
  if (runtime.getIdentityProvider() === null) {
    return { allowed: true, wsId };
  }

  const identity = runtime.getCurrentIdentity();
  if (!identity) {
    return { allowed: false, reason: "No authenticated identity" };
  }

  // STRICT: only a workspace admin member may write. Org role grants NO
  // bypass (see `canWriteWorkspaceScoped`).
  const ws = await runtime.getWorkspaceStore().get(wsId);
  const decision = canWriteWorkspaceScoped(identity, ws);
  return decision.allowed
    ? { allowed: true, wsId }
    : { allowed: false, reason: decision.reason ?? "Permission denied" };
}

// ── Source factory ───────────────────────────────────────────────────────

/** Source name — keep stable; settings UI calls `instructions__write_instructions`. */
export const INSTRUCTIONS_SOURCE_NAME = "instructions";

/**
 * Create the instructions platform source.
 *
 * The static resource reads live from `InstructionsStore` via the callback
 * form of `text` so reads always reflect the latest disk state. No caching,
 * per the locked decision: edits should apply mid-conversation.
 */
export function createInstructionsSource(runtime: Runtime, eventSink: EventSink): McpSource {
  // Holder so the write-tool handler can call `notifyResourceUpdated` on
  // the source it lives in. Set on the line after `defineInProcessApp`
  // returns; safe because handlers are only invoked after `start()`.
  const sourceHolder: { current: McpSource | null } = { current: null };

  const tools: InProcessTool[] = [
    {
      name: "write_instructions",
      description: WRITE_INSTRUCTIONS_DESCRIPTION,
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: InstructionsWriteInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        // A stale `scope` used to choose the file. The schema no longer declares
        // it and AJV lets unknown keys through, so ignoring it would silently
        // redirect an org-intended write onto the workspace overlay — which is
        // overwrite-only with no history, so the displaced body is gone. Refuse
        // instead, and say where org-wide guidance lives now. Removable once no
        // caller emits it.
        if ("scope" in input) {
          return {
            content: textContent(
              JSON.stringify({
                error:
                  "`scope` is removed — this tool writes the workspace overlay only. " +
                  "For guidance that should reach every workspace, author an org-tier " +
                  "skill (Organization → Skills) instead. Re-send with `body` alone.",
              }),
            ),
            isError: true,
          };
        }
        const body = String(input.body ?? "");
        const wsId = safeRequireWorkspace(runtime);

        const permission = await checkWritePermission(runtime, wsId);
        if (!permission.allowed) {
          return {
            content: textContent(JSON.stringify({ error: permission.reason })),
            isError: true,
          };
        }

        const store = runtime.getInstructionsStore();
        try {
          const result = await store.write({
            wsId: permission.wsId,
            text: body,
            // The settings UI is the only caller — the tool is internal, so no
            // agent reaches it. `UpdatedBy` keeps its `"agent"` arm for reading
            // meta files written before that was true (`readMeta` validates
            // against both).
            updatedBy: "ui",
          });

          // Best-effort live notification — drops silently when no client is
          // subscribed (between restarts). Same wire as any MCP server's
          // `notifications/resources/updated`.
          sourceHolder.current?.notifyResourceUpdated("instructions://workspace");

          return {
            content: textContent("Saved workspace instructions."),
            structuredContent: { ok: true, updated_at: result.updated_at },
            isError: false,
          };
        } catch (err) {
          return {
            content: textContent(
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
            isError: true,
          };
        }
      },
    },
  ];

  // Static resource map — the body is dynamic (callback form).
  const resources = new Map<string, { text: () => Promise<string>; mimeType: string }>([
    [
      "instructions://workspace",
      {
        mimeType: "text/markdown",
        text: () =>
          runtime.getInstructionsStore().read({
            wsId: runtime.requireWorkspaceId(),
          }),
      },
    ],
  ]);

  const source = defineInProcessApp(
    {
      name: INSTRUCTIONS_SOURCE_NAME,
      version: "1.0.0",
      tools,
      resources,
    },
    eventSink,
  );
  sourceHolder.current = source;
  return source;
}

/**
 * `requireWorkspaceId` throws on missing context. The write-tool handler
 * needs to map that to a permission denial (so the agent gets a clear
 * `isError: true` result instead of an exception that surfaces as a
 * crash). Wrap once and return null on failure.
 */
function safeRequireWorkspace(runtime: Runtime): string | null {
  try {
    return runtime.requireWorkspaceId();
  } catch {
    return null;
  }
}
