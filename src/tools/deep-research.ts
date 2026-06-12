import { createHash } from "node:crypto";
import { log } from "../cli/log.ts";
import {
  ArtifactsClient,
  isTerminalTaskStatus,
  NimbleTasksClient,
  type TaskRef,
} from "../dataplane/dataplane-client.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
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
 *   3. mint `aud=artifacts` → write the report to the artifacts store.
 *   4. return the artifact reference; the user resolves it to read the report.
 *
 * The bundle/worker never holds a data-plane credential: the runtime creates the
 * task and writes the artifact. The tool BLOCKS until the task is terminal — the
 * "async/durable" property is that the work runs in a separate, restart-surviving
 * Job with its own resources and timeout, not that this call returns early.
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
/** Keep the artifact title bounded — the query can be a long question. */
const TITLE_QUERY_MAX = 72;

export interface DeepResearchContext {
  /**
   * The request's workspace — the token/RLS dimension for both data-plane
   * services. Per-call (pulled from the runtime's current workspace context);
   * `null` when no workspace is bound, which fails the call cleanly.
   */
  getWorkspaceId: () => string | null;
  /** mcp-authorizer issuer the data-plane tokens mint against (`NB_FLEET_AUTHORIZER_ISSUER`). */
  issuer: string;
  /** nimbletasks base URL (`NB_NIMBLETASKS_URL`). */
  nimbletasksUrl: string;
  /** artifacts base URL (`NB_ARTIFACTS_URL`). */
  artifactsUrl: string;

  // ---- test seams (all optional; production omits them) ----
  /** Shared mint cache; defaults to the process-wide singleton inside the clients. */
  cache?: ServiceTokenCache;
  /** Injectable base fetch for the data-plane clients. */
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
 * Build the `nb__deep_research` InProcessTool. Present only when the runtime is
 * configured for the data plane (issuer + service URLs); absent on local dev so
 * the agent never sees a tool it can't drive.
 */
export function createDeepResearchTool(ctx: DeepResearchContext): InProcessTool {
  return {
    name: "deep_research",
    description:
      "Run deep web research on a query as a durable background task and save the result as a " +
      "retrievable artifact. Discovers sources, reads the top ones, and synthesizes a cited " +
      "markdown report. Long-running — may take minutes. Returns the artifact reference; resolve " +
      "the artifact to read the full report.",
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

      const clientOpts = {
        issuer: ctx.issuer,
        workspace,
        cache: ctx.cache,
        baseFetch: ctx.baseFetch,
      };
      const tasks = new NimbleTasksClient(ctx.nimbletasksUrl, clientOpts);
      const artifacts = new ArtifactsClient(ctx.artifactsUrl, clientOpts);

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

        const artifact = await artifacts.writeArtifact({
          type: "report",
          mimeType: "text/markdown",
          body: envelope.report,
          title: titleFor(query),
          citations: envelope.sources,
          // Tie the artifact key to the task so a re-run writes the report once.
          idempotencyKey: `dr-artifact-${terminal.taskId}`,
        });

        const sourceCount = envelope.sources?.length ?? 0;
        return {
          content: textContent(
            `Deep research complete. Report saved as artifact ${artifact.artifactId} ` +
              `(${artifact.uri}), ${sourceCount} source${sourceCount === 1 ? "" : "s"}. ` +
              "Resolve the artifact to read the full report.",
          ),
          structuredContent: {
            artifact_id: artifact.artifactId,
            uri: artifact.uri,
            mime_type: artifact.mimeType,
            size_bytes: artifact.sizeBytes,
            sources: sourceCount,
            task_id: terminal.taskId,
          },
          isError: false,
        };
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
