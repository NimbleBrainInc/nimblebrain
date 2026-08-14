/**
 * Instructions platform source — in-process MCP server.
 *
 * Owns one cross-cutting overlay:
 *   instructions://workspace   (set via workspace detail page or agent)
 *
 * Plus a single write tool, `write_instructions(body)`, gated so that only a
 * workspace admin member may write — an org role grants no bypass.
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
import type { EventSink, ToolResult } from "../../engine/types.ts";
import { getRequestContext } from "../../runtime/request-context.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { canWriteWorkspaceScoped } from "../../workspace/authz.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { InstructionsWriteInput } from "./schemas/instructions.ts";

// ── Tool description (description-as-policy) ─────────────────────────────

const WRITE_INSTRUCTIONS_DESCRIPTION =
  "Save workspace-wide custom instructions, applied to every conversation in this workspace. " +
  "**Use this only when the user explicitly asks to save a convention, or when you've identified a strongly recurring pattern that the user would benefit from persisting.** " +
  "Always confirm with the user before writing. " +
  "Empty text clears the instruction.";

// ── Permission helpers ───────────────────────────────────────────────────

interface PermissionDecision {
  allowed: boolean;
  /** When `allowed: false`, a one-line reason for the agent + UI. */
  reason?: string;
}

async function checkWritePermission(
  runtime: Runtime,
  wsId: string | null,
): Promise<PermissionDecision> {
  // Unattended-run wall, checked before every other gate including dev mode.
  //
  // This tool's whole posture is "confirm with the user before writing" — the
  // write persists into every later conversation in the workspace, for every
  // member. An unattended run has no user to confirm with, and is told so
  // ("there is nobody available to confirm choices — decide and proceed"),
  // while routinely ingesting untrusted content: email, web pages, tickets.
  // A "from now on…" line in any of that would otherwise reach a durable
  // cross-conversation write with nothing standing between them.
  //
  // Enforced HERE, at the source, for the reason `createAutomationsSource`
  // gives for the same wall: this is the single dispatch point every caller
  // funnels through, so it holds for the top-level run AND a delegated
  // sub-agent at any depth, regardless of whether the tool was ever surfaced
  // to the model. `unattended` rides the ambient request context and survives
  // the per-call restamp.
  if (getRequestContext()?.unattended) {
    return {
      allowed: false,
      reason:
        "Instructions cannot be written from inside an unattended automation run — " +
        "they persist across every later conversation in the workspace and there is no one " +
        "present to confirm the change. Write them from an interactive session.",
    };
  }

  // Dev mode (no identity provider configured) — allow writes through.
  // Matches the existing convention for dev-mode tool dispatch (see
  // `src/runtime/runtime.ts:getCurrentIdentity` — null in dev).
  if (runtime.getIdentityProvider() === null) {
    return { allowed: true };
  }

  const identity = runtime.getCurrentIdentity();
  if (!identity) {
    return { allowed: false, reason: "No authenticated identity" };
  }

  // STRICT: only a workspace admin member may write. Org role grants NO
  // bypass (see `canWriteWorkspaceScoped`).
  if (!wsId) {
    return { allowed: false, reason: "Writing instructions requires a workspace context" };
  }
  const ws = await runtime.getWorkspaceStore().get(wsId);
  const decision = canWriteWorkspaceScoped(identity, ws);
  return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
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
      inputSchema: InstructionsWriteInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const body = String(input.body ?? "");
        const wsId = safeRequireWorkspace(runtime);

        const permission = await checkWritePermission(runtime, wsId);
        if (!permission.allowed) {
          return {
            content: textContent(
              JSON.stringify({ error: permission.reason ?? "Permission denied" }),
            ),
            isError: true,
          };
        }

        const store = runtime.getInstructionsStore();
        try {
          const result = await store.write({
            wsId: wsId!,
            text: body,
            updatedBy: "agent",
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
