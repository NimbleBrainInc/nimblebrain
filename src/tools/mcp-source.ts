import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RemoteTransportConfig } from "../bundles/types.ts";
import { log } from "../cli/log.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ContentBlock, EventSink, ToolResult } from "../engine/types.ts";
import { createRemoteTransport } from "./remote-transport.ts";
import type { ResourceData, Tool, ToolSource } from "./types.ts";
import type { WorkspaceOAuthProvider } from "./workspace-oauth-provider.ts";

/**
 * Default time-to-live (ms) sent with task-augmented `tools/call` requests.
 * One hour fits research-run-style workloads; the server MAY clamp it down.
 * Override globally via `McpSource` constructor or per-bundle in the future.
 */
const DEFAULT_TASK_TTL_MS = 60 * 60 * 1000;

export type { ResourceData } from "./types.ts";

export interface McpSpawnConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/**
 * Narrow shape for a transport that can complete an OAuth authorization
 * code exchange. Both streamable-HTTP and SSE transports in the MCP SDK
 * expose this method when an `authProvider` is attached; a bare cast to
 * one concrete class would lie about which transport shapes are valid.
 */
type AuthFinishableTransport = Transport & {
  finishAuth?: (authorizationCode: string) => Promise<void>;
};

/** Discriminated union for how McpSource connects to its MCP server. */
export type McpTransportMode =
  | { type: "stdio"; spawn: McpSpawnConfig }
  | {
      type: "remote";
      url: URL;
      transportConfig?: RemoteTransportConfig;
      /**
       * Optional OAuth provider for the MCP SDK. When set and no static
       * `transportConfig.auth` is present, `createRemoteTransport` attaches
       * it to the client transport. If the server returns 401 on connect,
       * `start()` catches `UnauthorizedError`, awaits the provider's pending
       * flow for an authorization code, calls `transport.finishAuth`, and
       * retries `connect()` exactly once.
       */
      authProvider?: WorkspaceOAuthProvider;
    };

/**
 * ToolSource wrapping a single MCP server (stdio subprocess or remote HTTP/SSE).
 * Lazy tool loading: first tools() call triggers listTools(), then caches.
 * Crash recovery: on execute failure, attempts one restart + retry.
 */
export class McpSource implements ToolSource {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private cachedTools: Tool[] | null = null;
  private dead = false;
  private startedAt: number | null = null;

  /**
   * `eventSink` is REQUIRED, not optional. Emitted events include
   * `tool.progress` during task-augmented calls — when those events reach
   * the runtime sink wrap in `src/api/server.ts`, they turn into SSE
   * `data.changed` broadcasts which drive Synapse `useDataSync` in bundle
   * iframes.
   *
   * Pass `new NoopEventSink()` only when a caller deliberately wants to
   * discard events (e.g. short-lived sources that aren't part of an agent
   * session). "I didn't think about it" is not one of those cases —
   * that's what turned this parameter optional and silently broke live
   * updates across the whole platform.
   */
  constructor(
    readonly name: string,
    private mode: McpTransportMode,
    private eventSink: EventSink,
  ) {
    log.debug("mcp", `McpSource('${name}') constructed`);
  }

  /** Whether this source connects to a remote MCP server (HTTP/SSE). */
  isRemote(): boolean {
    return this.mode.type === "remote";
  }

  async start(): Promise<void> {
    if (this.mode.type === "stdio") {
      this.transport = new StdioClientTransport({
        command: this.mode.spawn.command,
        args: this.mode.spawn.args,
        env: this.mode.spawn.env,
        cwd: this.mode.spawn.cwd,
        stderr: "pipe",
      });
    } else {
      this.transport = createRemoteTransport(
        this.mode.url,
        this.mode.transportConfig,
        this.mode.authProvider,
      );

      // Remote: watch for transport close — mark source as dead
      this.transport.onclose = () => {
        this.dead = true;
        this.eventSink.emit({
          type: "run.error",
          data: { source: this.name, event: "source.crashed", error: "Remote transport closed" },
        });
      };
    }

    // Advertise client-side tasks capability per MCP spec draft 2025-11-25:
    // servers with `execution.taskSupport` on any tool see that this client
    // honors task-augmented `tools/call` and will attach `params.task: {ttl}`
    // when calling those tools. The engine then polls via tasks/get and
    // retrieves via tasks/result instead of blocking the request.
    this.client = new Client(
      { name: "nimblebrain", version: "0.1.0" },
      {
        capabilities: {
          tasks: {
            requests: { tools: { call: {} } },
            cancel: {},
            list: {},
          },
        },
      },
    );

    // Timeout MCP handshake — remote gets shorter timeout (15s vs 30s)
    const CONNECT_TIMEOUT = this.mode.type === "remote" ? 15_000 : 30_000;

    try {
      await this.connectWithTimeout(CONNECT_TIMEOUT);
    } catch (err) {
      // One-shot OAuth retry: if we have an authProvider and the SDK threw
      // UnauthorizedError, the provider's pending flow was either resolved
      // in-process (headless, e.g. Reboot Anonymous) or rejected with a
      // clear error (interactive, which we don't support yet). Await the
      // flow, finish auth on the EXISTING transport (so tokens land via
      // authProvider.saveTokens), then tear down the transport+client and
      // rebuild for the retry — `StreamableHTTPClientTransport` rejects a
      // second `start()` on the same instance (matching the SDK's own
      // `simpleOAuthClient` example pattern of new-transport-per-attempt).
      if (
        err instanceof UnauthorizedError &&
        this.mode.type === "remote" &&
        this.mode.authProvider &&
        this.transport
      ) {
        try {
          const code = await this.mode.authProvider.awaitPendingFlow();
          const authable = this.transport as AuthFinishableTransport;
          if (typeof authable.finishAuth !== "function") {
            throw new Error(
              `[mcp-source] transport does not support finishAuth (got ${this.transport.constructor.name})`,
            );
          }
          await authable.finishAuth(code);
          log.debug("mcp", `[oauth] ${this.name}: finishAuth ok, recreating transport for retry`);

          // Drop the first-attempt transport+client. Both are single-use
          // after a failed start; the SDK tracks internal state
          // (AbortController on the transport, handshake promise on the
          // client) that a second connect would trip over.
          await this.cleanupOnStartFailure();
          this.rebuildRemoteTransport();
          this.client = this.buildClient();

          await this.connectWithTimeout(CONNECT_TIMEOUT);
          this.startedAt = Date.now();
          return;
        } catch (retryErr) {
          await this.cleanupOnStartFailure();
          throw retryErr;
        }
      }

      await this.cleanupOnStartFailure();
      throw err;
    }

    this.dead = false;
    this.startedAt = Date.now();
  }

  private async connectWithTimeout(timeoutMs: number): Promise<void> {
    if (!this.client || !this.transport) {
      throw new Error("[mcp-source] connectWithTimeout called before init");
    }
    // Capture and clear the timer on BOTH success and failure; without this,
    // every successful connect leaks a 15–30s setTimeout that keeps the
    // event loop awake. Under the OAuth retry path this would fire twice
    // per successful start().
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`MCP connect timeout after ${timeoutMs / 1000}s for ${this.name}`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([this.client.connect(this.transport), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async cleanupOnStartFailure(): Promise<void> {
    try {
      if (this.transport) await this.transport.close();
    } catch (cleanupErr) {
      console.error("[mcp-source] transport cleanup failed:", cleanupErr);
    }
    this.client = null;
    this.transport = null;
  }

  /**
   * Rebuild a fresh remote transport after an OAuth 401 → retry. Uses the
   * same config as the original transport (URL, auth headers, provider) so
   * the retry sees exactly the same surface with a clean internal state.
   * Caller must have cleaned up the previous transport via
   * `cleanupOnStartFailure()` first.
   */
  private rebuildRemoteTransport(): void {
    if (this.mode.type !== "remote") {
      throw new Error("[mcp-source] rebuildRemoteTransport called on non-remote mode");
    }
    this.transport = createRemoteTransport(
      this.mode.url,
      this.mode.transportConfig,
      this.mode.authProvider,
    );
    this.transport.onclose = () => {
      this.dead = true;
      this.eventSink.emit({
        type: "run.error",
        data: { source: this.name, event: "source.crashed", error: "Remote transport closed" },
      });
    };
  }

  private buildClient(): Client {
    return new Client(
      { name: "nimblebrain", version: "0.1.0" },
      {
        capabilities: {
          tasks: {
            requests: { tools: { call: {} } },
            cancel: {},
            list: {},
          },
        },
      },
    );
  }

  /** Check if the transport is still connected. */
  isAlive(): boolean {
    return this.transport !== null && this.client !== null && !this.dead;
  }

  /** Time (ms) since the source was last started, or null if never started. */
  uptime(): number | null {
    if (this.startedAt === null) return null;
    return Date.now() - this.startedAt;
  }

  /** Restart the source (stop + start). Returns true on success. */
  async restart(): Promise<boolean> {
    return this.tryRestart();
  }

  async stop(): Promise<void> {
    try {
      if (this.client) await this.client.close();
      if (this.transport) await this.transport.close();
    } catch (err) {
      console.error("[mcp-source] stop failed:", err);
    }
    this.client = null;
    this.transport = null;
    this.cachedTools = null;
  }

  async tools(): Promise<Tool[]> {
    if (this.cachedTools) return this.cachedTools;
    if (!this.client) throw new Error(`McpSource "${this.name}" not started`);

    const response = await this.client.listTools();
    this.cachedTools = response.tools.map((t) => {
      const rawExec = (t as { execution?: unknown }).execution;
      const execution = isExecutionMeta(rawExec) ? { taskSupport: rawExec.taskSupport } : undefined;
      return {
        name: `${this.name}__${t.name}`,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        source: `mcpb:${this.name}`,
        annotations: t._meta as Record<string, unknown> | undefined,
        execution,
      };
    });
    return this.cachedTools;
  }

  /**
   * Look up the cached tool definition by bare tool name (no source prefix).
   *
   * `ToolRegistry.execute()` strips the `<sourceName>__` prefix before calling
   * `source.execute(localName, ...)`, so by the time we reach `callTool` we
   * only have the bare name. The cached `Tool` objects are stored fully
   * qualified, so re-qualify here.
   */
  private findTool(bareToolName: string): Tool | undefined {
    const fullName = `${this.name}__${bareToolName}`;
    return this.cachedTools?.find((t) => t.name === fullName);
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (!this.client || this.dead) {
      return { content: textContent(`McpSource "${this.name}" not started`), isError: true };
    }

    // Dispatch on whether the target tool supports task augmentation. Tools
    // that do (execution.taskSupport: "optional" | "required") are driven via
    // the SDK's streaming task API — the request returns a CreateTaskResult
    // immediately and we consume the stream of taskStatus messages until the
    // final `result` or `error`. Tools without task support use the
    // traditional inline path.
    const tool = this.findTool(toolName);
    const taskSupport = tool?.execution?.taskSupport;
    const isTaskAugmented = taskSupport === "optional" || taskSupport === "required";
    // Answers: "why is this tool call going inline vs task-augmented?" and
    // "is the tool cache populated?". Covers the whole dispatch decision in
    // one line. (eventSink is required at construction, so always present.)
    log.debug(
      "mcp",
      `execute source=${this.name} tool=${toolName}` +
        ` taskSupport=${taskSupport ?? "undefined"}` +
        ` path=${isTaskAugmented ? "task-augmented" : "inline"}` +
        ` cachedTools=${this.cachedTools ? this.cachedTools.length : "null"}`,
    );

    try {
      return isTaskAugmented
        ? await this.callToolAsTask(toolName, input, signal)
        : await this.callToolInline(toolName, input, signal);
    } catch (err) {
      // Cancellation isn't a crash — the source is healthy, the client just
      // asked to stop. Emit a terminal tool.progress for task-augmented
      // calls so UIs watching the progress stream transition out of
      // "working", then surface the error to the agent without marking
      // the source dead or triggering restart.
      const wasAborted = signal?.aborted === true;
      if (wasAborted) {
        if (isTaskAugmented) {
          this.eventSink.emit({
            type: "tool.progress",
            data: {
              source: this.name,
              tool: toolName,
              status: "cancelled",
              message: "Cancelled by client",
            },
          });
        }
        return {
          content: textContent("Task cancelled"),
          isError: true,
        };
      }

      this.dead = true;
      this.eventSink.emit({
        type: "run.error",
        data: { source: this.name, event: "source.crashed", error: String(err) },
      });

      // Crash-retry is ONLY safe for inline calls. A task-augmented call has
      // spawned server-side state (the task, an entity, possibly external
      // side effects); retrying would create a duplicate and orphan the
      // original. Surface the error and let the agent decide whether to
      // initiate a new run.
      if (isTaskAugmented) {
        return {
          content: textContent(
            `Task failed and cannot be auto-retried: ${err instanceof Error ? err.message : String(err)}`,
          ),
          isError: true,
        };
      }

      const restarted = await this.tryRestart();
      if (restarted) {
        try {
          return await this.callToolInline(toolName, input, signal);
        } catch (retryErr) {
          return {
            content: textContent(
              `Retry failed after restart: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
            ),
            isError: true,
          };
        }
      }
      return {
        content: textContent(`Server crashed and could not restart: ${this.name}`),
        isError: true,
      };
    }
  }

  /**
   * Read a resource from the MCP server (e.g. ui:// resources).
   * Returns structured resource data, or null if not found.
   *
   * Preserves `_meta` from both the per-content entry and the result-level
   * metadata. Per-content takes precedence on key overlap — the ext-apps
   * spec attaches ui metadata at the content level, so that's the load-bearing
   * source for iframe CSP / permissions / layout hints.
   */
  async readResource(uri: string): Promise<ResourceData | null> {
    if (!this.client) return null;
    try {
      const result = await this.client.readResource({ uri });
      if (!result.contents || result.contents.length === 0) return null;
      const first = result.contents[0]!;
      const meta = mergeResourceMeta(
        (result as { _meta?: Record<string, unknown> })._meta,
        (first as { _meta?: Record<string, unknown> })._meta,
      );
      if ("text" in first && typeof first.text === "string") {
        return { text: first.text, mimeType: first.mimeType, meta };
      }
      if ("blob" in first && typeof first.blob === "string") {
        const raw = atob(first.blob);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return { blob: bytes, mimeType: first.mimeType, meta };
      }
      return { text: JSON.stringify(first), meta };
    } catch {
      // Resource not found is expected (e.g., skill:// on servers that don't have one)
      return null;
    }
  }

  /** Expose the underlying MCP client (kept for tests and rare introspection). */
  getClient(): Client | null {
    return this.client;
  }

  /**
   * Inline tool invocation. Used for tools without task augmentation.
   *
   * The provided signal is forwarded as the SDK RequestOptions signal, so a
   * run-scoped abort cancels the in-flight RPC. Inline calls are expected to
   * finish within the stock MCP request timeout (~60s); use task-augmented
   * tools for anything longer.
   */
  private async callToolInline(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const result = await this.client?.callTool(
      { name: toolName, arguments: args },
      undefined,
      signal ? { signal } : undefined,
    );
    if (!result) return { content: [], isError: true };
    return {
      content: Array.isArray(result.content) ? (result.content as ContentBlock[]) : [],
      structuredContent: (result as Record<string, unknown>).structuredContent as
        | Record<string, unknown>
        | undefined,
      isError: Boolean(result.isError),
    };
  }

  /**
   * Task-augmented tool invocation, backed by the SDK's experimental task
   * streaming API (`client.experimental.tasks.callToolStream`).
   *
   * The stream yields a well-defined sequence of response messages:
   *   1. `taskCreated` — server acknowledged and assigned a taskId
   *   2. `taskStatus` (0+) — status transitions while the task runs
   *   3. terminal: `result` (success) or `error` (failure)
   *
   * This is the spec-compliant path for long-running work — `tools/call`
   * returns the CreateTaskResult in <1s, the SDK polls `tasks/get` on the
   * server-provided interval, and delivers the final CallToolResult via
   * `tasks/result` when the task reaches a terminal state. The 60s MCP
   * request timeout does NOT apply because no single request blocks.
   *
   * Cancellation: forwarding the engine's run-scoped AbortSignal causes the
   * SDK to send `tasks/cancel` to the server. The server's worker receives
   * `asyncio.CancelledError` (or equivalent) and transitions the task to
   * `cancelled`; the stream resolves with an `error` message.
   */
  private async callToolAsTask(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const client = this.client;
    if (!client) return { content: [], isError: true };

    const stream = client.experimental.tasks.callToolStream(
      {
        name: toolName,
        arguments: args,
        task: { ttl: DEFAULT_TASK_TTL_MS },
      },
      undefined,
      signal ? { signal } : undefined,
    );

    let taskId: string | undefined;
    for await (const message of stream) {
      switch (message.type) {
        case "taskCreated":
          taskId = message.task.taskId;
          this.eventSink.emit({
            type: "tool.progress",
            data: {
              source: this.name,
              tool: toolName,
              taskId,
              status: message.task.status,
              message: message.task.statusMessage,
            },
          });
          break;

        case "taskStatus":
          this.eventSink.emit({
            type: "tool.progress",
            data: {
              source: this.name,
              tool: toolName,
              taskId: message.task.taskId,
              status: message.task.status,
              message: message.task.statusMessage,
            },
          });
          break;

        case "result": {
          const { content, structuredContent, isError } = message.result;
          return {
            content: Array.isArray(content) ? (content as ContentBlock[]) : [],
            structuredContent: structuredContent as Record<string, unknown> | undefined,
            isError: Boolean(isError),
          };
        }

        case "error":
          return {
            content: textContent(
              message.error?.message ?? `Task ${taskId ?? "?"} failed without detail`,
            ),
            isError: true,
          };
      }
    }

    // The SDK's contract is that the stream always terminates with result or
    // error; reaching here indicates a protocol violation upstream. Treat as
    // an error so the agent loop can continue.
    return {
      content: textContent(`Task ${taskId ?? "?"} stream ended without a terminal message`),
      isError: true,
    };
  }

  private async tryRestart(): Promise<boolean> {
    try {
      await this.stop();
      await this.start();
      this.cachedTools = null;
      this.dead = false;
      this.eventSink.emit({
        type: "run.error",
        data: { source: this.name, event: "source.restarted" },
      });
      return true;
    } catch (err) {
      this.eventSink.emit({
        type: "run.error",
        data: { source: this.name, event: "source.restart_failed", error: String(err) },
      });
      return false;
    }
  }
}

/** Type guard: does this unknown value match Tool.execution's shape? */
function isExecutionMeta(
  value: unknown,
): value is { taskSupport?: "optional" | "required" | "forbidden" } {
  if (value === null || typeof value !== "object") return false;
  const ts = (value as { taskSupport?: unknown }).taskSupport;
  return ts === undefined || ts === "optional" || ts === "required" || ts === "forbidden";
}

/**
 * Merge result-level and content-level `_meta` from an MCP `ReadResourceResult`.
 *
 * Shallow top-level spread: any top-level key present on `contentMeta`
 * **replaces** the same key from `resultMeta` wholesale (no per-field deep
 * merge). Example: given `resultMeta = { ui: { a: 1 } }` and
 * `contentMeta = { ui: { b: 2 } }`, the result is `{ ui: { b: 2 } }`, not
 * `{ ui: { a: 1, b: 2 } }`.
 *
 * The ext-apps spec attaches ui metadata at the content level, so
 * content-wins is the right precedence when both sides declare `ui` — a
 * resource's view of its own capabilities should replace any container-level
 * hint, not mix with it. Keys that exist on one side only pass through
 * unchanged. Returns undefined when both sides are empty so consumers can
 * skip metadata handling cleanly.
 */
function mergeResourceMeta(
  resultMeta: Record<string, unknown> | undefined,
  contentMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!resultMeta && !contentMeta) return undefined;
  return { ...(resultMeta ?? {}), ...(contentMeta ?? {}) };
}
