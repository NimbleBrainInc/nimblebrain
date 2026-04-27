/**
 * Instructions platform source — in-process MCP server.
 *
 * Owns the cross-cutting overlays:
 *   instructions://org         (slot reserved — no UI yet, agent-set only)
 *   instructions://workspace   (live — set via workspace detail page or agent)
 *
 * Plus a single write tool, `write_instructions(scope, text)`, with role
 * gates (workspace admin or org admin/owner can write workspace; only org
 * admin/owner can write org).
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
import type { Scope } from "../../instructions/index.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";

// ── Roles ────────────────────────────────────────────────────────────────

/**
 * Org-level roles allowed to write `org`-scope instructions, and (combined
 * with workspace-admin role) `workspace`-scope instructions.
 *
 * Mirrors `ORG_ADMIN_ROLES` in `src/tools/workspace-mgmt-tools.ts:389` —
 * intentionally duplicated rather than imported because that module's
 * `canManageMembers` helper is tagged deprecated. The tiny set is stable.
 */
const ORG_ADMIN_ROLES = new Set(["admin", "owner"]);

// ── Tool description (description-as-policy) ─────────────────────────────

const WRITE_INSTRUCTIONS_DESCRIPTION =
  "Save org-wide or workspace-wide custom instructions. " +
  "**Use this only when the user explicitly asks to save a convention, or when you've identified a strongly recurring pattern that the user would benefit from persisting.** " +
  "Always confirm with the user before writing org-scope or workspace-scope instructions. " +
  "Scope must be `org` or `workspace`. Empty text clears the instruction.";

// ── Permission helpers ───────────────────────────────────────────────────

interface PermissionDecision {
  allowed: boolean;
  /** When `allowed: false`, a one-line reason for the agent + UI. */
  reason?: string;
}

async function checkScopePermission(
  runtime: Runtime,
  scope: Scope,
  wsId: string | null,
): Promise<PermissionDecision> {
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

  const isOrgAdmin = ORG_ADMIN_ROLES.has(identity.orgRole);

  if (scope === "org") {
    return isOrgAdmin
      ? { allowed: true }
      : { allowed: false, reason: "Org-scope writes require org admin or owner" };
  }

  // workspace scope — org admin/owner OR workspace admin.
  if (isOrgAdmin) return { allowed: true };

  if (!wsId) {
    return { allowed: false, reason: "Workspace-scope writes require a workspace context" };
  }
  const ws = await runtime.getWorkspaceStore().get(wsId);
  if (!ws) {
    return { allowed: false, reason: `Workspace "${wsId}" not found` };
  }
  const member = ws.members.find((m) => m.userId === identity.id);
  return member?.role === "admin"
    ? { allowed: true }
    : {
        allowed: false,
        reason: "Workspace-scope writes require workspace admin (or org admin/owner)",
      };
}

// ── Source factory ───────────────────────────────────────────────────────

/** Source name — keep stable; settings UI calls `instructions__write_instructions`. */
export const INSTRUCTIONS_SOURCE_NAME = "instructions";

/**
 * Create the instructions platform source.
 *
 * The two static resources read live from `InstructionsStore` via the
 * callback form of `text` so reads always reflect the latest disk state.
 * No caching, per the locked decision: edits should apply mid-conversation.
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
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["org", "workspace"],
            description:
              "Which overlay to write. `org` applies platform-wide; `workspace` applies to the active workspace only.",
          },
          text: {
            type: "string",
            description: "Markdown body. Empty string clears the overlay.",
          },
        },
        required: ["scope", "text"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const scope = input.scope as Scope;
        const text = String(input.text ?? "");
        const wsId = scope === "workspace" ? safeRequireWorkspace(runtime) : null;

        const permission = await checkScopePermission(runtime, scope, wsId);
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
          const result =
            scope === "org"
              ? await store.write({ scope: "org", text, updatedBy: "agent" })
              : await store.write({
                  scope: "workspace",
                  wsId: wsId!,
                  text,
                  updatedBy: "agent",
                });

          // Best-effort live notification — drops silently when no client is
          // subscribed (between restarts). Same wire as any MCP server's
          // `notifications/resources/updated`.
          const uri = scope === "org" ? "instructions://org" : "instructions://workspace";
          sourceHolder.current?.notifyResourceUpdated(uri);

          return {
            content: textContent(`Saved ${scope} instructions.`),
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

  // Static resource map — both bodies are dynamic (callback form).
  const resources = new Map<string, { text: () => Promise<string>; mimeType: string }>([
    [
      "instructions://org",
      {
        mimeType: "text/markdown",
        text: () => runtime.getInstructionsStore().read({ scope: "org" }),
      },
    ],
    [
      "instructions://workspace",
      {
        mimeType: "text/markdown",
        text: () =>
          runtime.getInstructionsStore().read({
            scope: "workspace",
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
