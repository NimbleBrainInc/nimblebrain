import { createHash } from "node:crypto";
import { log } from "../cli/log.ts";
import {
  isTerminalTaskStatus,
  NimbleTasksClient,
  type TaskRef,
} from "../dataplane/dataplane-client.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ContentBlock, ToolResult } from "../engine/types.ts";
import type { OutputStore } from "../files/output-store.ts";
import type { ServiceTokenCache } from "../oauth/tenant-key-mint.ts";
import type { InProcessTool } from "./in-process-app.ts";

/**
 * `nb__deep_research` — the runtime's trigger for the durable deep-research
 * task. The agent calls it with a query; the runtime drives the whole job and
 * returns a reference to the saved report.
 *
 * Flow (the runtime is the only tenant-bound principal — see dataplane-client.ts):
 *   1. mint `aud=mcp-fleet` → POST a `research.deep_research` task to nimbletasks.
 *   2. poll the task to a terminal status (the baked web worker does the work in
 *      its own Job — discover sources, read them, synthesize a cited report).
 *   3. persist the report through the kernel `OutputStore` seam → `files://<id>`.
 *   4. return a SHORT summary + a `resource_link` to the stored report; the
 *      client fetches the report (via the `nb` source's resource handler) and
 *      renders it.
 *
 * The bundle/worker never holds a data-plane credential: the runtime creates the
 * task and writes the output. The tool BLOCKS until the task is terminal — the
 * "async/durable" property is that the work runs in a separate, restart-surviving
 * Job with its own resources and timeout, not that this call returns early.
 *
 * Persistence goes through the `OutputStore` seam (NOT a direct ArtifactsClient):
 * the dataplane backend writes to the artifacts service, the local backend to the
 * workspace file store, and both round-trip a `files://<id>` ref. ArtifactsClient
 * is referenced ONLY inside the dataplane backend now.
 *
 * Result shape (the jsonl/context fix): the report does NOT live in the tool
 * result's text `content` (a ~24K report is under MAX_TOOL_RESULT_CHARS, so it
 * would re-enter model context every turn). Instead the text is a one-line
 * summary and the report rides as a per-call `resource_link` block — the engine
 * persists the REF, and `rehydrateUserResources` materializes the bytes only on
 * the turn that needs them, under a budget. When NO store resolves (off-platform)
 * we fall back to a bounded inline report so research still works.
 */

/** Task type the baked web worker is registered to handle (chart `values-staging`). */
const DEEP_RESEARCH_TASK_TYPE = "research.deep_research";
/** Audit breadcrumbs recorded on the task row. */
const MCP_SERVER_NAME = "web";
const TOOL_NAME = "deep_research";

const DEFAULT_POLL_INTERVAL_MS = 3_000;
// The worker's own timeout is 600s (`deploy/chart/values-staging.yaml`). Wait a
// little past that so a task that runs to its own limit still resolves here
// rather than being abandoned mid-flight.
const DEFAULT_MAX_WAIT_MS = 660_000;
/** Keep the output title bounded — the query can be a long question. */
const TITLE_QUERY_MAX = 72;
// The off-platform / persistence-failure fallback returns the report INLINE so
// the agent presents the real research (never a bare ref it can't resolve —
// that's what let it fabricate from memory). Bounded so a long report doesn't
// blow the turn. The store path does NOT use this — there the report rides as a
// resource_link, not inline text.
const INLINE_REPORT_MAX = 16_000;

export interface DeepResearchContext {
  /**
   * The request's workspace — the token/RLS dimension for the task runner and
   * the output store. Per-call (pulled from the runtime's current workspace
   * context); `null` when no workspace is bound, which fails the call cleanly.
   */
  getWorkspaceId: () => string | null;
  /**
   * The resolved task runner (nimbletasks). `baseUrl` + `issuer` come from the
   * runtime's `resolveTaskRunner` selection — the tool is wired ONLY when a
   * dataplane task runner resolves, so this is always present here.
   */
  taskRunner: { baseUrl: string; issuer: string };
  /**
   * The resolved output store (dataplane | local), or `null` when no store
   * provider resolves (off-platform). With a store the report is persisted and
   * returned as a `resource_link`; with `null` it falls back to a bounded
   * inline report so research still works without any data plane.
   */
  store: OutputStore | null;

  // ---- test seams (all optional; production omits them) ----
  /** Shared mint cache; defaults to the process-wide singleton inside the client. */
  cache?: ServiceTokenCache;
  /** Injectable base fetch for the task-runner client. */
  baseFetch?: typeof fetch;
  /** Injectable clock for the poll deadline. */
  now?: () => number;
  /** Injectable delay between polls. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

/** The report envelope the web `deep_research` tool synthesizes. */
interface ResearchEnvelope {
  report: string;
  sources?: Array<{ title?: string; url?: string }>;
}

/**
 * Surface a clean, human-readable failure to the agent (and through it the
 * user). Any technical detail goes to the runtime logs (stderr → Loki/Grafana),
 * never into the tool result a user sees — a raw "unable to verify the first
 * certificate" is an operator concern, not something to put in the chat.
 */
function fail(userMessage: string, detail?: string, level: "warn" | "error" = "error"): ToolResult {
  if (detail) log[level](`[deep_research] ${detail}`);
  return { content: textContent(userMessage), isError: true };
}

function normalizeSources(raw: unknown): Array<{ title?: string; url?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ title?: string; url?: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title : undefined;
    const url = typeof o.url === "string" ? o.url : undefined;
    if (title || url) out.push({ title, url });
  }
  return out.length > 0 ? out : undefined;
}

/** Read `{report, sources}` out of a stored task result. The worker reports an
 *  MCP-tool-result dict (`{content, isError, structuredContent}`); the report
 *  rides in `structuredContent`, with the JSON-encoded text block as a fallback
 *  for transports that drop structured content. */
function extractEnvelope(result: unknown): ResearchEnvelope | null {
  const fromObject = (obj: Record<string, unknown>): ResearchEnvelope | null => {
    if (typeof obj.report !== "string" || obj.report.length === 0) return null;
    return { report: obj.report, sources: normalizeSources(obj.sources) };
  };

  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  // Direct envelope (defensive — a future transport could unwrap it).
  const direct = fromObject(r);
  if (direct) return direct;

  // structuredContent — the normal path.
  if (r.structuredContent && typeof r.structuredContent === "object") {
    const structured = fromObject(r.structuredContent as Record<string, unknown>);
    if (structured) return structured;
  }

  // Fallback: a JSON-encoded text content block.
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        try {
          const parsed = JSON.parse((block as Record<string, unknown>).text as string);
          if (parsed && typeof parsed === "object") {
            const fromText = fromObject(parsed as Record<string, unknown>);
            if (fromText) return fromText;
          }
        } catch {
          // Not the JSON envelope block — keep scanning.
        }
      }
    }
  }

  return null;
}

function titleFor(query: string): string {
  const trimmed = query.length > TITLE_QUERY_MAX ? `${query.slice(0, TITLE_QUERY_MAX)}…` : query;
  return `Deep research: ${trimmed}`;
}

function sourcesLabel(count: number): string {
  return `${count} source${count === 1 ? "" : "s"}`;
}

/** Poll a task to a terminal status, or `null` if the deadline passes first. */
async function pollToTerminal(
  tasks: NimbleTasksClient,
  initial: TaskRef,
  ctx: DeepResearchContext,
): Promise<TaskRef | null> {
  if (isTerminalTaskStatus(initial.status)) return initial;

  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = ctx.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = now() + (ctx.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);

  while (now() < deadline) {
    await sleep(interval);
    const current = await tasks.getTask(initial.taskId);
    if (isTerminalTaskStatus(current.status)) return current;
  }
  return null;
}

/**
 * Success WITH a store: the report is persisted and surfaced as a resource_link.
 * The tool text is a SHORT one-liner; the report does NOT enter `content`, so
 * the conversation log persists the REF, not the report bytes.
 */
function storedResult(opts: {
  uri: string;
  id: string;
  title: string;
  sourceCount: number;
  taskId: string;
  sizeBytes: number;
}): ToolResult {
  const resourceLink: ContentBlock = {
    type: "resource_link",
    uri: opts.uri,
    name: opts.title,
    mimeType: "text/markdown",
  } as ContentBlock;
  return {
    content: [
      {
        type: "text",
        text:
          `Deep research complete — ${sourcesLabel(opts.sourceCount)}. The full report has ` +
          "been delivered to the user as an attached document and is already rendered in their " +
          "UI. Do NOT reproduce, restate, quote, or summarize the report — reply with a brief " +
          "one-sentence confirmation only. If the user later asks about its contents, call " +
          "nb__get_output to read it then.",
      },
      resourceLink,
    ],
    structuredContent: {
      output_id: opts.id,
      uri: opts.uri,
      mime_type: "text/markdown",
      size_bytes: opts.sizeBytes,
      sources: opts.sourceCount,
      task_id: opts.taskId,
    },
    isError: false,
  };
}

/**
 * Fallback when no store resolves OR the store write failed: return the REAL
 * report INLINE (bounded). This is real research content, not a fabrication —
 * the agent must present it verbatim. `note` distinguishes the off-platform case
 * (no store) from the couldn't-save case (had a store, write failed).
 */
function inlineResult(opts: {
  report: string;
  sourceCount: number;
  taskId: string;
  note?: string;
}): ToolResult {
  const overCap = opts.report.length > INLINE_REPORT_MAX;
  const reportBody = overCap
    ? `${opts.report.slice(0, INLINE_REPORT_MAX)}\n\n[Report truncated to the first ${INLINE_REPORT_MAX} characters.]`
    : opts.report;
  const head =
    `Deep research complete — ${sourcesLabel(opts.sourceCount)}.` +
    (opts.note ? ` ${opts.note}` : "") +
    "\nPresent the report below to the user as-is; do not add facts that are not in it.";
  return {
    content: textContent(`${head}\n\n---\n\n${reportBody}`),
    structuredContent: {
      sources: opts.sourceCount,
      task_id: opts.taskId,
      report_truncated: overCap,
      inline_fallback: true,
    },
    isError: false,
  };
}

/**
 * Build the `nb__deep_research` InProcessTool. Present only when the runtime
 * resolved a dataplane task runner (the durable Job that does the work);
 * absent off-platform so the agent never sees a tool it can't drive. The output
 * store may still be `null` here (task runner up, store off) — that path
 * degrades to a bounded inline report rather than failing.
 */
export function createDeepResearchTool(ctx: DeepResearchContext): InProcessTool {
  return {
    name: "deep_research",
    description:
      "Run deep web research on a query as a durable background task and save the result as a " +
      "retrievable report. Discovers sources, reads the top ones, and synthesizes a cited " +
      "markdown report. Long-running — may take minutes. On success the report is delivered to " +
      "the user as an attached document (returned as a resource_link) and rendered in their UI — " +
      "do NOT reproduce or restate it; reply with a brief confirmation. Retrieve its full " +
      "contents later via nb__get_output using the returned reference.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The research topic or question to investigate.",
        },
      },
      required: ["query"],
    },
    handler: async (input): Promise<ToolResult> => {
      const query = String(input.query ?? "").trim();
      if (!query) return fail("Please give me a topic or question to research.");

      const workspace = ctx.getWorkspaceId();
      if (!workspace) {
        return fail(
          "Deep research isn't available here right now.",
          "no workspace was bound to the request",
        );
      }

      const tasks = new NimbleTasksClient(ctx.taskRunner.baseUrl, {
        issuer: ctx.taskRunner.issuer,
        workspace,
        cache: ctx.cache,
        baseFetch: ctx.baseFetch,
      });

      // Content-addressed idempotency: identical (workspace, query) research
      // dedups to one task, so a re-run returns the existing task's result
      // rather than paying for the work twice.
      const idem = createHash("sha256").update(`${workspace}\n${query}`).digest("hex").slice(0, 32);

      try {
        const created = await tasks.createTask({
          taskType: DEEP_RESEARCH_TASK_TYPE,
          input: { query },
          idempotencyKey: `dr-${idem}`,
          mcpServer: MCP_SERVER_NAME,
          toolName: TOOL_NAME,
        });

        const terminal = await pollToTerminal(tasks, created, ctx);
        if (!terminal) {
          return fail(
            "The research is taking longer than expected and hasn't finished yet. " +
              "Please try again in a few minutes.",
            `task ${created.taskId} did not reach a terminal status within the poll window`,
            "warn",
          );
        }
        if (terminal.status !== "completed") {
          return fail(
            "The research didn't finish successfully. Please try again in a few minutes.",
            `task ${terminal.taskId} ${terminal.status}` +
              (terminal.statusMessage ? `: ${terminal.statusMessage}` : ""),
            "warn",
          );
        }

        const { available, result } = await tasks.getResult(terminal.taskId);
        if (!available) {
          return fail(
            "The research finished but I couldn't retrieve the report. Please try again.",
            `task ${terminal.taskId} completed but its result was not available`,
          );
        }
        const envelope = extractEnvelope(result);
        if (!envelope) {
          return fail(
            "The research finished but the report came back in an unexpected format. " +
              "Please try again.",
            `task ${terminal.taskId} returned an unrecognized result shape`,
          );
        }

        const sourceCount = envelope.sources?.length ?? 0;

        // No store resolved (off-platform): bounded inline report so research
        // still works without any data plane. The report is real content.
        if (!ctx.store) {
          return inlineResult({
            report: envelope.report,
            sourceCount,
            taskId: terminal.taskId,
          });
        }

        // Persist through the store seam. The idempotency key is STABLE per task
        // (`dr-artifact-<taskId>`), so a re-run of the same (workspace, query) —
        // which the content-addressed task key already dedups to one task — writes
        // the report ONCE rather than minting a duplicate artifact each call. On a
        // write failure we still have the REAL report in hand — inline-fallback it
        // (real content, not a fabrication) with a "couldn't save durably" note
        // rather than failing.
        try {
          const ref = await ctx.store.put(
            { workspace },
            {
              kind: "report",
              producedBy: "tool:deep_research",
              mime: "text/markdown",
              body: envelope.report,
              title: titleFor(query),
              citations: envelope.sources,
              idempotencyKey: `dr-artifact-${terminal.taskId}`,
            },
          );
          return storedResult({
            uri: ref.uri,
            id: ref.id,
            title: titleFor(query),
            sourceCount,
            taskId: terminal.taskId,
            sizeBytes: ref.sizeBytes,
          });
        } catch (e) {
          const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
          log.warn(
            `[deep_research] task ${terminal.taskId} completed but OutputStore.put failed: ${detail}`,
          );
          return inlineResult({
            report: envelope.report,
            sourceCount,
            taskId: terminal.taskId,
            note: "I couldn't save it durably, so it isn't retrievable later — here it is in full.",
          });
        }
      } catch (e) {
        // Network / TLS / mint / data-plane failures. The raw detail (e.g. a
        // cert-verification message or a 5xx body) is an operator concern — log
        // it, show the user a calm "try again".
        const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
        return fail(
          "Deep research is temporarily unavailable — I couldn't reach the research service. " +
            "Please try again in a few minutes.",
          detail,
        );
      }
    },
  };
}
