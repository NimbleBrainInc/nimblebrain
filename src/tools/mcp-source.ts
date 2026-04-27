import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, CreateTaskResult, Task } from "@modelcontextprotocol/sdk/types.js";
import type { PlacementDeclaration, RemoteTransportConfig } from "../bundles/types.ts";
import { log } from "../cli/log.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ContentBlock, EventSink, ToolResult } from "../engine/types.ts";
import { createRemoteTransport } from "./remote-transport.ts";
import {
  type ResourceData,
  TaskAlreadyTerminalError,
  TaskNotFoundError,
  type TaskOwnerContext,
  type Tool,
  type ToolSource,
} from "./types.ts";
import type { WorkspaceOAuthProvider } from "./workspace-oauth-provider.ts";

/**
 * Default time-to-live (ms) sent with task-augmented `tools/call` requests.
 * One hour fits research-run-style workloads; the server MAY clamp it down.
 * Override globally via `McpSource` constructor or per-bundle in the future.
 */
const DEFAULT_TASK_TTL_MS = 60 * 60 * 1000;

/**
 * Grace window after a task's declared TTL before the sweeper purges the
 * handle. Callers that fetch the terminal result a little late still get it;
 * anything beyond this is gone.
 */
const TASK_HANDLE_GRACE_MS = 60 * 1000;

/** Sweeper cadence (ms). Mirrors the `/mcp` session sweeper. */
const TASK_SWEEPER_INTERVAL_MS = 60_000;

/**
 * Hard ceiling on how long we wait between `startToolAsTask` call and the
 * stream yielding `taskCreated`. Guards against a server that accepts a
 * task-augmented `tools/call` then never acknowledges it — the 60s MCP
 * default request timeout would already have fired by then, so this is
 * more of a safety net than a driver.
 */
const TASK_CREATED_TIMEOUT_MS = 60_000;

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
    }
  | {
      type: "inProcess";
      /**
       * Factory that creates a fresh in-process MCP server and a linked
       * client-side transport on each call. Invoked by `start()`; called
       * again on `restart()`.
       *
       * Why a factory instead of a pre-built pair: an `InMemoryTransport`
       * pair is single-use after close, and `Server.connect()` claims
       * ownership of one side. To support clean restart, each `start()`
       * needs a fresh pair (and a freshly-connected `Server`). The factory
       * is the obvious encapsulation — the helper that builds platform
       * sources (`defineInProcessApp`) lives next door and produces this
       * factory directly.
       */
      createServer: () => Promise<{ server: Server; clientTransport: Transport }>;
      /**
       * UI placements declared by this source. Read by the runtime via
       * `getPlacements()` and registered in the platform `PlacementRegistry`.
       *
       * Carried on the mode (rather than passed separately) because it's
       * static configuration tied to the source's identity — the source
       * either declares placements or it doesn't, and the value never
       * changes across restarts.
       */
      placements?: PlacementDeclaration[];
    };

/**
 * Internal bookkeeping for an in-flight or recently-terminal task.
 *
 * Lifecycle:
 *   1. `startToolAsTask` creates the handle, drives the stream to the
 *      `taskCreated` message, stamps `ownerContext`, fires the background
 *      drainer, and returns the `CreateTaskResult`.
 *   2. The drainer updates `latestTask` on every `taskStatus`, resolves
 *      `terminalDeferred` on `result`/`error`, and marks the handle terminal.
 *   3. `awaitToolTaskResult` awaits `terminalDeferred`.
 *   4. `cancelTask` calls `abortController.abort()` — the SDK translates that
 *      into a `tasks/cancel` dispatch; the drainer observes the terminal
 *      `error` message and resolves the handle.
 *   5. After `lastUpdatedAt + ttl + grace`, the sweeper deletes the entry.
 */
interface TaskHandle {
  taskId: string;
  toolName: string;
  ownerContext: TaskOwnerContext;
  /** Most recent `Task` payload we've observed from the stream. */
  latestTask: Task;
  /** Populated once the stream emits a terminal message. */
  terminal?: { result: CallToolResult } | { error: Error };
  /** Resolves / rejects with the terminal CallToolResult. */
  terminalDeferred: Deferred<CallToolResult>;
  /** Drives `tasks/cancel` on the upstream. */
  abortController: AbortController;
  /**
   * Set when cancellation came from a call to `cancelTask(...)` (as opposed
   * to a generic external AbortSignal passed at start time). Used by the
   * drainer to decide whether to reject the terminal deferred (cancelTask
   * explicitly rejects pending `awaitToolTaskResult` callers per task 001
   * acceptance criteria) or resolve it with `isError: true` (generic
   * stream-level errors stay on the resolve path so the agent-loop wrapper
   * returns the same ToolResult shape as before the split).
   */
  cancelRequested: boolean;
  /** When we'll allow the sweeper to purge the handle (ms since epoch). */
  expiresAt: number;
}

/** Tiny Promise helper — we need both sides of the promise here. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  /** Optional `instructions` string returned by the MCP server during
   *  `initialize`. Captured after connect so callers (e.g. the system
   *  prompt composer) can surface per-bundle guidance to the LLM. */
  private _instructions: string | undefined;
  /**
   * For `inProcess` mode only — the linked-pair MCP server that this source
   * speaks to. Owned by McpSource (constructed in `start()` via
   * `mode.createServer`, closed in `stop()`) so platform sources participate
   * in the same start/stop/restart lifecycle as subprocess and remote
   * sources without their authors having to wire it themselves.
   */
  private inProcessServer: Server | null = null;
  /**
   * Per-source task handle map. Keyed by server-assigned taskId. Shared
   * between `startToolAsTask`, `awaitToolTaskResult`, `getTaskStatus`,
   * `cancelTask`, and the background drainers they spawn.
   */
  private taskHandles = new Map<string, TaskHandle>();
  /** Sweeper interval. Kept so `stop()` can cancel it. */
  private sweeperInterval: ReturnType<typeof setInterval> | null = null;

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
    } else if (this.mode.type === "remote") {
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
    } else {
      // In-process: the factory builds a fresh InMemoryTransport pair and an
      // already-connected Server on each call, so restart is a clean slate.
      // We hold the Server so `stop()` can close it explicitly — without that
      // the pair-side close still works, but the Server's internal handler
      // tables hang on until GC.
      const { server, clientTransport } = await this.mode.createServer();
      this.inProcessServer = server;
      this.transport = clientTransport;

      this.transport.onclose = () => {
        this.dead = true;
        this.eventSink.emit({
          type: "run.error",
          data: {
            source: this.name,
            event: "source.crashed",
            error: "In-process transport closed",
          },
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

    // Capture the server's initialize `instructions` field (may be undefined).
    // The MCP SDK stores it internally; we expose it via getInstructions() so
    // the system prompt composer can render it in the apps list.
    const instructions = this.client.getInstructions();
    this._instructions = typeof instructions === "string" ? instructions : undefined;

    this.startTaskSweeper();
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
      if (this.inProcessServer) await this.inProcessServer.close();
    } catch (cleanupErr) {
      console.error("[mcp-source] transport cleanup failed:", cleanupErr);
    }
    this.client = null;
    this.transport = null;
    this.inProcessServer = null;
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
    // Abort any in-flight streams so their drainers unblock and the handle
    // map can be cleared without leaking outstanding `awaitToolTaskResult`
    // callers. Each drainer will reject its terminalDeferred, which is
    // exactly the semantic we want on shutdown.
    this.stopTaskSweeper();
    for (const handle of this.taskHandles.values()) {
      try {
        handle.abortController.abort();
      } catch {
        // ignore
      }
      if (!handle.terminal) {
        const err = new Error(`Task ${handle.taskId} aborted: source stopped`);
        handle.terminal = { error: err };
        handle.terminalDeferred.reject(err);
      }
    }
    this.taskHandles.clear();

    try {
      if (this.client) await this.client.close();
      if (this.transport) await this.transport.close();
      // In-process: also close the linked Server so its handler tables and
      // any task-related state are released. Closing the client side of the
      // pair propagates close to the server side, but `server.close()` is
      // the explicit, supported teardown.
      if (this.inProcessServer) await this.inProcessServer.close();
    } catch (err) {
      console.error("[mcp-source] stop failed:", err);
    }
    this.client = null;
    this.transport = null;
    this.inProcessServer = null;
    this.cachedTools = null;
    this._instructions = undefined;
  }

  /** Server `instructions` string from the MCP `initialize` response.
   *  Undefined until start() completes; cleared by stop(). */
  getInstructions(): string | undefined {
    return this._instructions;
  }

  /**
   * Best-effort `notifications/resources/list_changed` to connected clients.
   *
   * Emitted globally by the underlying MCP server — the SDK is responsible
   * for routing to subscribers (clients that issued `resources/subscribe` are
   * filtered server-side). Callers do not need to track per-subscriber state.
   *
   * Only meaningful for `inProcess` sources, where this `McpSource` owns the
   * server end of the linked-pair transport. For `stdio` and `remote` modes,
   * the source is a *client* of an external server and has nothing to emit
   * on — call becomes a silent no-op.
   *
   * Drops silently between `stop()` and the next successful `start()` (the
   * `inProcessServer` field is cleared in those windows). This matches the
   * MCP semantic that resource notifications are advisory: a client that
   * missed one re-fetches via `resources/list` or `resources/read`.
   */
  notifyResourceListChanged(): void {
    const server = this.inProcessServer;
    if (!server) return;
    void server.notification({ method: "notifications/resources/list_changed" }).catch((err) => {
      log.debug("mcp", `[${this.name}] notifyResourceListChanged failed: ${String(err)}`);
    });
  }

  /**
   * Best-effort `notifications/resources/updated` for a single resource URI.
   *
   * Emitted globally by the underlying MCP server; the SDK filters delivery
   * to clients that previously sent `resources/subscribe` for this URI. We
   * do not track subscriber lists here.
   *
   * No-op semantics match {@link notifyResourceListChanged}: only meaningful
   * for `inProcess` sources, drops silently between `stop()` and the next
   * `start()`. A client that missed the notification will see the new
   * content the next time it reads the resource.
   */
  notifyResourceUpdated(uri: string): void {
    const server = this.inProcessServer;
    if (!server) return;
    void server
      .notification({ method: "notifications/resources/updated", params: { uri } })
      .catch((err) => {
        log.debug("mcp", `[${this.name}] notifyResourceUpdated(${uri}) failed: ${String(err)}`);
      });
  }

  /**
   * UI placements declared by this source. Populated for `inProcess` mode
   * (platform built-ins); `[]` for stdio/remote sources, whose placements
   * come from the bundle manifest and are tracked separately by the
   * bundle lifecycle.
   *
   * Read by the runtime at start time to register placements in the
   * platform `PlacementRegistry`. Static — doesn't change across restarts.
   */
  getPlacements(): PlacementDeclaration[] {
    if (this.mode.type === "inProcess") {
      return this.mode.placements ?? [];
    }
    return [];
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
   * Thin wrapper that preserves the pre-split agent-loop contract:
   * start the task, await its terminal result, return a single `ToolResult`.
   *
   * Behaviour is intentionally identical to the previous monolithic
   * implementation — the per-phase methods are used directly by the
   * `/mcp` endpoint (Task 002) where the two halves run in different
   * JSON-RPC requests.
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
    const start = await this.startToolAsTask(toolName, args, {
      // Agent-loop default owner context. The /mcp entry path will pass a
      // workspace-scoped one; inside the agent, all sources are already
      // workspace-scoped at registry-selection time, so an agent-loop
      // pseudo-context is fine.
      ownerContext: { workspaceId: `__agent__:${this.name}` },
      signal,
    });

    // No taskId means the server couldn't create one (or upstream protocol
    // violation surfaced as an error). `awaitToolTaskResult` will reject
    // with a descriptive error, which the outer `execute()` catch maps to
    // a tool ToolResult.
    const callToolResult = await this.awaitToolTaskResult(start.task.taskId, {
      ownerContext: { workspaceId: `__agent__:${this.name}` },
    });

    return {
      content: Array.isArray(callToolResult.content)
        ? (callToolResult.content as ContentBlock[])
        : [],
      structuredContent: callToolResult.structuredContent as Record<string, unknown> | undefined,
      isError: Boolean(callToolResult.isError),
    };
  }

  /**
   * Phase 1 of the split task API: open the SDK task stream, drain it up to
   * (and including) the `taskCreated` message, stamp a `TaskHandle`, and
   * spawn a background drainer that accumulates subsequent `taskStatus`
   * messages and resolves on the terminal `result`/`error`.
   *
   * Returns the initial `CreateTaskResult` synchronously so callers can
   * forward it to their own task-augmented client (the `/mcp` endpoint) in
   * sub-second time.
   *
   * The `ownerContext` is stamped into the handle and MUST match on every
   * subsequent `getTaskStatus` / `awaitToolTaskResult` / `cancelTask`.
   *
   * The optional `signal` is chained into the handle's internal abort
   * controller — aborting from outside cancels the upstream stream, which
   * the SDK translates into `tasks/cancel`.
   *
   * Rejects with a descriptive error if:
   *   - the stream terminates before yielding `taskCreated`,
   *   - the first non-`taskCreated` message is a terminal `error`,
   *   - the stream hangs for longer than `TASK_CREATED_TIMEOUT_MS`.
   */
  async startToolAsTask(
    toolName: string,
    args: Record<string, unknown>,
    opts: { ownerContext: TaskOwnerContext; signal?: AbortSignal; ttlMs?: number },
  ): Promise<CreateTaskResult> {
    const client = this.client;
    if (!client || this.dead) {
      throw new Error(`McpSource "${this.name}" not started`);
    }

    const abortController = new AbortController();
    const externalSignal = opts.signal;
    if (externalSignal) {
      if (externalSignal.aborted) abortController.abort();
      else externalSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    // Pass `task: { ttl }` via *options*, NOT inside `params`. The SDK's
    // `Protocol.request` stamps `params.task = options.task` AFTER reading
    // the caller's params, so any ttl we set in `params.task` here is
    // overridden by the SDK's `optionsWithTask.task` (which auto-fills `{}`
    // for tools advertising `taskSupport`). Putting it in options threads
    // through correctly. See `@modelcontextprotocol/sdk` `protocol.js:654`
    // and `experimental/tasks/client.js:67`.
    const stream = client.experimental.tasks.callToolStream(
      { name: toolName, arguments: args },
      undefined,
      {
        signal: abortController.signal,
        task: { ttl: opts.ttlMs ?? DEFAULT_TASK_TTL_MS },
      },
    );

    // Race the stream's first message against a hard ceiling. The SDK
    // normally responds to `tools/call` in milliseconds; anything that
    // stalls for a full minute before producing `taskCreated` is a broken
    // server and we shouldn't block the caller indefinitely.
    const first = await raceWithTimeout(
      stream.next(),
      TASK_CREATED_TIMEOUT_MS,
      `Timed out waiting for taskCreated from ${this.name}:${toolName}`,
    );
    if (first.done) {
      throw new Error(`Stream from ${this.name}:${toolName} ended before yielding taskCreated`);
    }
    const firstMsg = first.value as { type: string; task?: Task; error?: { message?: string } };
    if (firstMsg.type === "error") {
      throw new Error(
        firstMsg.error?.message ?? `Task creation failed for ${this.name}:${toolName}`,
      );
    }
    if (firstMsg.type !== "taskCreated" || !firstMsg.task) {
      throw new Error(
        `Protocol violation: first stream message from ${this.name}:${toolName} was ${firstMsg.type}, expected taskCreated`,
      );
    }

    const task = firstMsg.task;
    const taskId = task.taskId;

    const handle: TaskHandle = {
      taskId,
      toolName,
      ownerContext: { ...opts.ownerContext },
      latestTask: task,
      abortController,
      terminalDeferred: deferred<CallToolResult>(),
      cancelRequested: false,
      expiresAt: computeExpiry(task),
    };
    // Attach a no-op catch to the terminal promise so drainer-side
    // rejections (cancellation, transport crash, sweep) don't surface as
    // unhandled rejections when no caller is currently awaiting. Callers
    // that DO await get the rejection normally.
    handle.terminalDeferred.promise.catch(() => {});
    this.taskHandles.set(taskId, handle);

    // Emit the initial progress event inline so callers see `taskCreated`
    // before `startToolAsTask` returns.
    this.eventSink.emit({
      type: "tool.progress",
      data: {
        source: this.name,
        tool: toolName,
        taskId,
        status: task.status,
        message: task.statusMessage,
      },
    });

    // Drain the rest of the stream in the background. Errors here resolve
    // via `terminalDeferred.reject` — there's no outer `await` to catch them.
    void this.drainTaskStream(handle, stream, toolName);

    // CreateTaskResult per MCP spec 2025-11-25 wraps the Task in a `task`
    // field. The SDK's stream doesn't surface the outer envelope directly
    // (it hands us the parsed inner Task), but the JSON-RPC contract the
    // `/mcp` handler needs to re-emit is `{ task: Task }`.
    return { task };
  }

  /**
   * Phase 2 of the split task API: block until the handle terminates, then
   * return the final `CallToolResult` (or throw on failure/cancellation).
   *
   * Owner-context mismatch → `TaskNotFoundError` (we deliberately do not
   * distinguish "wrong owner" from "no such task" to avoid leaking
   * existence).
   */
  async awaitToolTaskResult(
    taskId: string,
    opts: { ownerContext: TaskOwnerContext },
  ): Promise<CallToolResult> {
    const handle = this.lookupHandle(taskId, opts.ownerContext);
    return handle.terminalDeferred.promise;
  }

  /**
   * Non-blocking peek at a task's current status.
   *
   * Returns the cached `Task` if the stream has yielded at least one update;
   * otherwise falls back to `tasks/get` on the upstream server.
   */
  async getTaskStatus(taskId: string, opts: { ownerContext: TaskOwnerContext }): Promise<Task> {
    const handle = this.lookupHandle(taskId, opts.ownerContext);
    // If the handle has a terminal status cached, return that — it's the
    // authoritative final state. Otherwise return the latest streamed Task.
    if (handle.terminal || isTerminalStatus(handle.latestTask.status)) {
      return handle.latestTask;
    }
    // For still-working tasks, prefer live upstream if possible so callers
    // get fresh `pollInterval` / `statusMessage` without having to wait for
    // the next `taskStatus` message.
    const client = this.client;
    if (client) {
      try {
        const upstream = await client.experimental.tasks.getTask(taskId);
        handle.latestTask = upstream;
        handle.expiresAt = computeExpiry(upstream);
        return upstream;
      } catch {
        // Fall through to cached — the upstream call can fail if the
        // server forgot about the task (TTL expiry) or the connection
        // flapped. We still have our last-known state.
      }
    }
    return handle.latestTask;
  }

  /**
   * Phase 4 of the split task API: transition a running task to `cancelled`.
   *
   * Cancelling a task that is already in a terminal state is a protocol
   * error per MCP spec 2025-11-25 — the `/mcp` layer maps that to JSON-RPC
   * `-32602`. We surface the condition as `TaskAlreadyTerminalError` so the
   * caller can do the mapping with structured information.
   */
  async cancelTask(taskId: string, opts: { ownerContext: TaskOwnerContext }): Promise<Task> {
    const handle = this.lookupHandle(taskId, opts.ownerContext);
    if (handle.terminal || isTerminalStatus(handle.latestTask.status)) {
      throw new TaskAlreadyTerminalError(taskId, handle.latestTask.status);
    }

    // Aborting the controller kicks the SDK into sending `tasks/cancel`
    // and tearing down the stream iterator. The drainer observes the
    // thrown error (or subsequent stream-level error) and, because we set
    // `cancelRequested`, rejects the terminal deferred — any in-flight
    // `awaitToolTaskResult` caller will see that rejection. We wait for
    // the drainer to settle so the caller gets an up-to-date Task.
    handle.cancelRequested = true;
    handle.abortController.abort();

    // The drainer will settle the terminalDeferred; we also want to wait
    // for the latestTask.status to flip to `cancelled`. The cleanest
    // observable signal is the terminalDeferred — it settles via the
    // drainer regardless of success or failure. Swallow rejection because
    // the contract of cancelTask is to return the final Task, not the
    // CallToolResult.
    try {
      await handle.terminalDeferred.promise;
    } catch {
      // ignore — we're about to return the status regardless
    }
    // Normalize the status to `cancelled` if the drainer exited via an
    // abort error but didn't update the status explicitly.
    if (!isTerminalStatus(handle.latestTask.status)) {
      handle.latestTask = {
        ...handle.latestTask,
        status: "cancelled",
        lastUpdatedAt: new Date().toISOString(),
      };
    }
    return handle.latestTask;
  }

  /**
   * Internal task handle lookup.
   *
   * Returns the handle if (a) it exists and (b) the caller's
   * `TaskOwnerContext` matches the one stamped at `startToolAsTask` time.
   * Any mismatch — including a missing entry, a different workspace, a
   * different identity, or a different originApp — throws
   * `TaskNotFoundError`. The error intentionally does NOT distinguish
   * "wrong owner" from "no such task".
   */
  private lookupHandle(taskId: string, context: TaskOwnerContext): TaskHandle {
    const handle = this.taskHandles.get(taskId);
    if (!handle) throw new TaskNotFoundError(taskId);
    if (!ownerMatches(handle.ownerContext, context)) {
      throw new TaskNotFoundError(taskId);
    }
    return handle;
  }

  /**
   * Background drainer for the SDK task stream. Runs per-task from
   * `startToolAsTask` until the stream terminates.
   *
   * Responsibilities:
   *   - Emit `tool.progress` for every `taskStatus` so the chat UI renders live.
   *   - Refresh `handle.latestTask` on every `taskStatus`.
   *   - Resolve `handle.terminalDeferred` on `result`, reject on `error`.
   *   - On thrown errors (transport crash, abort), reject + stamp a
   *     `failed` / `cancelled` Task so `getTaskStatus` returns something
   *     sensible post-mortem.
   */
  private async drainTaskStream(
    handle: TaskHandle,
    stream: AsyncGenerator<unknown, void, void>,
    toolName: string,
  ): Promise<void> {
    try {
      for await (const raw of stream) {
        const message = raw as {
          type: string;
          task?: Task;
          result?: CallToolResult;
          error?: { message?: string };
        };
        switch (message.type) {
          case "taskStatus": {
            if (!message.task) break;
            handle.latestTask = message.task;
            handle.expiresAt = computeExpiry(message.task);
            this.eventSink.emit({
              type: "tool.progress",
              data: {
                source: this.name,
                tool: toolName,
                taskId: handle.taskId,
                status: message.task.status,
                message: message.task.statusMessage,
              },
            });
            break;
          }
          case "taskCreated":
            // `startToolAsTask` already consumed the first taskCreated.
            // A second one would be a protocol oddity; ignore gracefully.
            break;
          case "result": {
            if (!message.result) break;
            handle.terminal = { result: message.result };
            handle.latestTask = {
              ...handle.latestTask,
              status: "completed",
              lastUpdatedAt: new Date().toISOString(),
            };
            handle.expiresAt = Date.now() + TASK_HANDLE_GRACE_MS;
            handle.terminalDeferred.resolve(message.result);
            return;
          }
          case "error": {
            // Two sub-cases here:
            //   1. A caller invoked `cancelTask(...)` → per task 001
            //      acceptance criteria, in-flight `awaitToolTaskResult`
            //      callers must be rejected with a descriptive error.
            //   2. Clean stream-level `error` from the server (task failed
            //      without cancellation) → resolve with `isError: true` so
            //      the agent-loop wrapper preserves its historical return
            //      shape. Rejection is reserved for transport crashes /
            //      protocol violations so `execute()`'s catch branch makes
            //      the right restart decision.
            const errMessage = message.error?.message ?? `Task ${handle.taskId} failed`;
            if (handle.cancelRequested) {
              const err = new Error(`Task ${handle.taskId} cancelled: ${errMessage}`);
              handle.terminal = { error: err };
              handle.latestTask = {
                ...handle.latestTask,
                status: "cancelled",
                statusMessage: errMessage,
                lastUpdatedAt: new Date().toISOString(),
              };
              handle.expiresAt = Date.now() + TASK_HANDLE_GRACE_MS;
              handle.terminalDeferred.reject(err);
              return;
            }
            const isAborted = handle.abortController.signal.aborted;
            const callToolResult: CallToolResult = {
              content: [{ type: "text", text: errMessage }],
              isError: true,
            };
            handle.terminal = { result: callToolResult };
            handle.latestTask = {
              ...handle.latestTask,
              status: isAborted ? "cancelled" : "failed",
              statusMessage: errMessage,
              lastUpdatedAt: new Date().toISOString(),
            };
            handle.expiresAt = Date.now() + TASK_HANDLE_GRACE_MS;
            handle.terminalDeferred.resolve(callToolResult);
            return;
          }
        }
      }
      // Stream ended without a terminal message — protocol violation.
      const err = new Error(`Task ${handle.taskId} stream ended without a terminal message`);
      handle.terminal = { error: err };
      handle.latestTask = {
        ...handle.latestTask,
        status: "failed",
        statusMessage: err.message,
        lastUpdatedAt: new Date().toISOString(),
      };
      handle.expiresAt = Date.now() + TASK_HANDLE_GRACE_MS;
      handle.terminalDeferred.reject(err);
    } catch (err) {
      // Transport crash or abort. The outer `execute()` catch handles
      // surfacing this to the agent loop; here we just make sure the
      // handle is in a defensible state for post-mortem inspection.
      const wasAborted = handle.abortController.signal.aborted;
      const finalStatus = wasAborted ? "cancelled" : "failed";
      handle.terminal = { error: err instanceof Error ? err : new Error(String(err)) };
      handle.latestTask = {
        ...handle.latestTask,
        status: finalStatus,
        statusMessage: err instanceof Error ? err.message : String(err),
        lastUpdatedAt: new Date().toISOString(),
      };
      handle.expiresAt = Date.now() + TASK_HANDLE_GRACE_MS;
      handle.terminalDeferred.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private startTaskSweeper(): void {
    if (this.sweeperInterval) return;
    this.sweeperInterval = setInterval(() => this.sweepExpiredTasks(), TASK_SWEEPER_INTERVAL_MS);
    // Don't pin the process alive just for the sweeper.
    if (this.sweeperInterval && typeof this.sweeperInterval === "object") {
      const unref = (this.sweeperInterval as { unref?: () => void }).unref;
      if (typeof unref === "function") unref.call(this.sweeperInterval);
    }
  }

  private stopTaskSweeper(): void {
    if (this.sweeperInterval) {
      clearInterval(this.sweeperInterval);
      this.sweeperInterval = null;
    }
  }

  /**
   * Purge task handles whose expiry has passed.
   *
   * Still-running tasks get an expiry derived from `lastUpdatedAt + ttl +
   * grace` — the drainer refreshes this on every `taskStatus` so healthy
   * tasks won't be swept. Terminal tasks get `now + grace`, which gives
   * late-arriving `awaitToolTaskResult` callers a small window to fetch
   * the result before the entry is collected.
   *
   * Exposed via `sweepExpiredTasksForTesting` so tests can force-advance
   * the sweeper without juggling fake timers.
   */
  private sweepExpiredTasks(): void {
    const now = Date.now();
    for (const [taskId, handle] of this.taskHandles) {
      if (handle.expiresAt <= now) {
        // Safety net: ensure the terminalDeferred is settled before we
        // delete the entry. Otherwise a dangling `awaitToolTaskResult`
        // caller would hang forever. The `.catch(() => {})` attached at
        // handle creation guarantees no unhandled rejection if nobody is
        // currently awaiting — callers that DO await still see the error.
        if (!handle.terminal) {
          try {
            handle.abortController.abort();
          } catch {
            // ignore
          }
          const err = new Error(`Task ${taskId} swept after ttl`);
          handle.terminal = { error: err };
          handle.terminalDeferred.reject(err);
        }
        this.taskHandles.delete(taskId);
      }
    }
  }

  /**
   * Test-only escape hatch — calls the sweeper immediately and returns the
   * number of remaining handles. Public so tests can exercise TTL-based
   * purge without juggling fake timers or mocking `setInterval`.
   *
   * Production code MUST NOT call this.
   */
  _sweepExpiredTasksForTesting(): number {
    this.sweepExpiredTasks();
    return this.taskHandles.size;
  }

  /**
   * Test-only introspection — returns the number of live task handles.
   * Production code MUST NOT call this.
   */
  _taskHandleCountForTesting(): number {
    return this.taskHandles.size;
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

/**
 * Task statuses considered terminal per MCP spec 2025-11-25. `working` and
 * `input_required` are the only non-terminal states.
 */
function isTerminalStatus(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Do two `TaskOwnerContext` values refer to the same owner? */
function ownerMatches(stamped: TaskOwnerContext, candidate: TaskOwnerContext): boolean {
  if (stamped.workspaceId !== candidate.workspaceId) return false;
  // If the stamp includes an identity, the candidate must match it exactly.
  if (stamped.identityId !== undefined && stamped.identityId !== candidate.identityId) {
    return false;
  }
  if (stamped.originApp !== undefined && stamped.originApp !== candidate.originApp) {
    return false;
  }
  return true;
}

/** Compute a handle's expiry from the latest Task payload. */
function computeExpiry(task: Task): number {
  const ttl = typeof task.ttl === "number" && task.ttl > 0 ? task.ttl : DEFAULT_TASK_TTL_MS;
  const lastUpdated = Date.parse(task.lastUpdatedAt);
  const base = Number.isFinite(lastUpdated) ? lastUpdated : Date.now();
  return base + ttl + TASK_HANDLE_GRACE_MS;
}

/**
 * Race a promise against a timeout. Used to bound the wait for the SDK
 * stream's first message — a server that accepts `tools/call` then never
 * responds shouldn't hang the caller indefinitely.
 */
function raceWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
