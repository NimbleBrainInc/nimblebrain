import { log } from "../cli/log.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import {
  decodeOutputText,
  type OutputStore,
  OutputStoreDisabledError,
  outputRefToId,
} from "../files/output-store.ts";
import type { InProcessTool } from "./in-process-app.ts";

/**
 * `nb__get_output` — fetch a stored output's FULL content by `files://` ref.
 *
 * This is the uncapped retrieval path: unlike `nb__read_resource` (a 12K
 * "peek"), `get_output` returns the whole body via `OutputStore.get`. It is the
 * answer to "retrieve my past report" — a deep-research report written to the
 * store can be long, and the user wants all of it.
 *
 * Registered only when an output-store provider RESOLVES (dataplane | local).
 * When the provider is `null` the tool is omitted entirely (mirrors how
 * `deepResearchCtx` gates `nb__deep_research`), so the agent never sees a tool
 * it can't drive.
 *
 * Workspace fencing: the scope is taken from the runtime's CURRENT workspace
 * context — never a field on the request body. The dataplane backend enforces
 * the same scope at the RLS boundary (its read token is workspace-dimensioned);
 * for the identity-owned local store we additionally compare the resolved
 * output's recorded workspace and refuse a cross-workspace read. Either way the
 * caller cannot widen its own scope.
 */

export interface GetOutputContext {
  /**
   * The request's workspace — the scope dimension for the read. Per-call
   * (pulled from the runtime's current workspace context); `null` when no
   * workspace is bound, which fails the call cleanly.
   */
  getWorkspaceId: () => string | null;
  /** The resolved output store (dataplane | local). Never the `null` backend —
   *  the tool is omitted entirely when the provider doesn't resolve. */
  store: OutputStore;
}

/** Surface a clean failure to the agent; technical detail goes to the logs. */
function fail(userMessage: string, detail?: string): ToolResult {
  if (detail) log.warn(`[get_output] ${detail}`);
  return { content: textContent(userMessage), isError: true };
}

export function createGetOutputTool(ctx: GetOutputContext): InProcessTool {
  return {
    name: "get_output",
    description:
      "Retrieve the FULL content of a previously saved output (e.g. a deep-research report or a " +
      "generated document) by its reference. Pass the `files://<id>` ref returned when the output " +
      "was created. Returns the complete body — unlike read_resource, this is not truncated. Use " +
      "this when the user wants to read or work with a past result in full.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "The output reference to retrieve (a `files://<id>` URI, or a bare id).",
        },
      },
      required: ["ref"],
    },
    handler: async (input): Promise<ToolResult> => {
      const raw = String(input.ref ?? "").trim();
      if (!raw) return fail("Please give me the reference of the output to retrieve.");

      // Accept either a full `files://<id>` ref or a bare id. Any OTHER scheme
      // (e.g. skill://, ui://) is not an output ref — reject without touching
      // the store.
      let id: string | null;
      if (raw.includes("://")) {
        id = outputRefToId(raw);
        if (!id) {
          return fail(
            `"${raw}" is not an output reference. Outputs are referenced as files://<id>.`,
            `rejected non-files ref ${raw}`,
          );
        }
      } else {
        id = raw;
      }

      const workspace = ctx.getWorkspaceId();
      if (!workspace) {
        return fail(
          "I can't retrieve that output here right now.",
          "no workspace was bound to the request",
        );
      }

      try {
        const content = await ctx.store.get({ workspace }, id);

        // Defense in depth for the identity-owned local store: the dataplane
        // backend already fenced this at the RLS boundary, but the local store
        // resolves any of the identity's files regardless of workspace. If the
        // stored output records a DIFFERENT workspace, refuse — same not-found
        // shape as an unknown id, so a foreign ref leaks nothing.
        if (content.meta.workspace && content.meta.workspace !== workspace) {
          return fail(
            `Output "${id}" was not found.`,
            `denied cross-workspace read: output workspace ${content.meta.workspace} != request workspace ${workspace}`,
          );
        }

        const isText = content.meta.mime.startsWith("text/") || content.meta.mime.includes("json");
        if (!isText) {
          return {
            content: textContent(
              `Output ${id} is ${content.meta.mime} (${content.meta.sizeBytes} bytes) and isn't text — ` +
                `it can't be shown inline. Title: ${content.meta.title ?? "(untitled)"}.`,
            ),
            structuredContent: {
              id: content.meta.id,
              uri: content.meta.uri,
              mime_type: content.meta.mime,
              size_bytes: content.meta.sizeBytes,
              title: content.meta.title,
            },
            isError: false,
          };
        }

        // FULL body — no READ_RESOURCE_MAX_CHARS cap. This is the whole point.
        const body = decodeOutputText(content);
        const citations = content.meta.citations ?? [];
        return {
          content: textContent(body),
          structuredContent: {
            id: content.meta.id,
            uri: content.meta.uri,
            kind: content.meta.kind,
            produced_by: content.meta.producedBy,
            mime_type: content.meta.mime,
            title: content.meta.title,
            size_bytes: content.meta.sizeBytes,
            created_at: content.meta.createdAt,
            citations,
          },
          isError: false,
        };
      } catch (e) {
        // A disabled store should never reach here (the tool is omitted when
        // the provider is null), but handle it explicitly rather than as a raw
        // crash. Everything else (missing id, store/network error) becomes a
        // clean not-found — no stack trace to the user.
        if (e instanceof OutputStoreDisabledError) {
          return fail("Saved outputs aren't available here.", e.message);
        }
        const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
        return fail(`Output "${id}" was not found.`, detail);
      }
    },
  };
}
