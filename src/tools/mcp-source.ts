import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, CreateTaskResult, Task } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolResultSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PlacementDeclaration, RemoteTransportConfig } from "../bundles/types.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ContentBlock, EventSink, ToolResult } from "../engine/types.ts";
import {
  HOST_RESOURCES_LIST_METHOD,
  HOST_RESOURCES_READ_METHOD,
  type HostResourcesRateLimit,
  type HostResourcesResolver,
  hostExtensions,
} from "../host-resources/index.ts";
import { requestIdentityAttrs, withSpan } from "../observability/index.ts";
import { log } from "../observability/log.ts";
import { coerceInputForSchema } from "./coerce-input.ts";
import { promoteHiddenErrors } from "./promote-hidden-errors.ts";
import { createRemoteTransport } from "./remote-transport.ts";
import { scrubArgsForDispatch } from "./scrub-args.ts";
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

/**
 * Bundle stderr ring buffer cap. Keeps the last N lines of subprocess
 * stderr so we can attach them to a `source.crashed` event payload — long
 * enough for a typical Python traceback, short enough not to drown the
 * event payload in a runaway log.
 */
const STDERR_TAIL_MAX_LINES = 50;

/**
 * Per-bundle context threaded into McpSource so its Client can answer
 * inbound `ai.nimblebrain/resources/*` requests. Owned by the caller
 * (lifecycle, workspace-ops) which knows the workspace; passed into the
 * constructor at spawn time. Absent for in-process platform sources —
 * they are the platform talking to itself and have no business asking
 * the host for resources.
 */
export interface BundleMcpContext {
  workspaceId: string;
  /** The McpSource name (bundle slug). Used for audit + rate-limit attribution. */
  bundleId: string;
  hostResources: HostResourcesResolver;
  rateLimit: HostResourcesRateLimit;
}

/**
 * Inbound request schemas — the standard MCP `resources/{read,list}`
 * shapes with the method literal swapped for our namespaced extension.
 * `ZodObject.extend` overrides the matching key, so the schema's params
 * shape (uri / cursor / filter) carries through unchanged from the
 * spec-blessed types. Layer 3 migration is just `s/ai.nimblebrain\///`.
 */
const NbReadResourceRequestSchema = ReadResourceRequestSchema.extend({
  method: z.literal(HOST_RESOURCES_READ_METHOD),
});
const NbListResourcesRequestSchema = ListResourcesRequestSchema.extend({
  method: z.literal(HOST_RESOURCES_LIST_METHOD),
});

/**
 * Hard cap on a single stderr line we'll log or buffer. A bundle that
 * writes a 100MB single line should not OOM the host or balloon an event
 * payload. Truncation is marked so the developer knows it happened.
 */
const STDERR_LINE_MAX_CHARS = 8192;

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
       * Dev-mode `allowInsecureRemotes` flag, threaded to the SSRF redirect
       * guard in `createRemoteTransport` so http://localhost endpoints work in
       * local development. Defaults to false (production posture).
       */
      allowInsecure?: boolean;
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
 * Sanitize an untrusted `serverInfo.version` before we store or surface it. The
 * string comes from the MCP server — a Composio gateway or a third-party OAuth
 * server controls it — so drop C0/C1 control characters and cap the length.
 * Display-only; never a security signal. Returns undefined if nothing usable
 * remains.
 */
export function sanitizeReportedVersion(raw: string): string | undefined {
  const printable = Array.from(raw)
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp > 0x1f && !(cp >= 0x7f && cp <= 0x9f);
    })
    .join("")
    .trim();
  // Cap by code points, not UTF-16 units: slicing the string directly could cut
  // an astral character at the 64-unit boundary and leave a lone surrogate.
  const capped = Array.from(printable).slice(0, 64).join("");
  return capped || undefined;
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
  /** A restart in progress, shared so concurrent recoveries reuse one
   *  stop()/start() cycle instead of stacking. Resource reads are NOT serialized
   *  the way the engine serializes tool calls, so a remote roll can land several
   *  session-loss reads here at once; without this each would fire its own
   *  restart — a restart storm on a single source. */
  private restartInFlight: Promise<boolean> | null = null;
  /** Backoff schedule for `recover`'s re-establish loop. Defaults to
   *  `SESSION_RECOVERY_DELAYS_MS`; overridable so tests exercise the policy
   *  branches without real sleeps. */
  private recoveryDelaysMs?: readonly number[];
  private startedAt: number | null = null;
  /** Optional `instructions` string returned by the MCP server during
   *  `initialize`. Captured after connect so callers (e.g. the system
   *  prompt composer) can surface per-bundle guidance to the LLM. */
  private _instructions: string | undefined;
  /** Sanitized `serverInfo.version` reported in the `initialize` response.
   *  Untrusted (the server sets it); display-only. Undefined until start()
   *  completes, if the server reports none, or after stop(). */
  private _serverVersion: string | undefined;
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
   * Last-N lines of subprocess stderr, fed by `attachStderrReader`. Read
   * by the `transport.onclose` handler to attach `stderrTail` to the
   * outgoing `source.crashed` event so postmortem consumers (console event
   * sink, web UI later) can render the traceback. Reset at the top of
   * every `start()` so a restart doesn't inherit a dead instance's tail.
   *
   * Empty (and stays empty) for `remote` and `inProcess` modes — they
   * don't have a subprocess and there is no stderr to drain.
   */
  private stderrTail: string[] = [];
  /**
   * Holds bytes received from the stderr stream that haven't yet been
   * terminated by a newline. Pythonic `print(end="")` and progress-bar
   * carriage-return updates don't terminate with `\n`, so we accumulate
   * here until we see one (or the stream ends, at which point the
   * partial-line is flushed verbatim).
   */
  private stderrLineBuf = "";
  /**
   * Set inside `stop()` so the transport's `onclose` handler — which
   * fires synchronously during `transport.close()` — can distinguish a
   * deliberate teardown from an unexpected death and skip emitting a
   * `source.crashed` event in the first case. Without this guard,
   * graceful stops would surface as spurious crash events to listeners.
   */
  private stopping = false;
  /**
   * Set true ONLY by a deliberate `stop()` (teardown / disconnect), reset by
   * `start()`. Distinct from `stopping`, which `cleanupOnStartFailure()` also
   * sets to suppress crash noise on a failed start: a failed start is
   * retryable, a deliberate teardown is not. `HealthMonitor` reads this (via
   * {@link isStopped}) to leave a deliberately-stopped, registry-removed source
   * terminal instead of reconnecting an orphaned instance.
   */
  private stopped = false;

  /**
   * Listeners notified when this source's enumerable tool set may have
   * changed — a successful (re)connect (initial start, HealthMonitor restart,
   * deferred/pending-auth start completing) or a server-pushed native
   * `notifications/tools/list_changed`. `ToolRegistry` subscribes one per
   * registry the source belongs to and bridges the signal to the
   * cross-workspace tool-list aggregator's per-workspace invalidation, so a
   * union memoized while the source was unreachable refreshes the moment it
   * comes online. See {@link ToolSource.subscribeToolsChanged}.
   */
  private readonly toolsChangedListeners = new Set<() => void>();

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
   *
   * `bundleContext` is optional and threaded only on bundle-spawning
   * paths. When set, the Client registers inbound handlers for
   * `ai.nimblebrain/resources/{read,list}` against the bundle's
   * workspace. In-process platform sources don't pass it (they're MCP
   * servers talking to the platform itself, not bundles requesting
   * platform resources).
   */
  constructor(
    readonly name: string,
    private mode: McpTransportMode,
    private eventSink: EventSink,
    private readonly bundleContext?: BundleMcpContext,
  ) {
    log.debug("mcp", `McpSource('${name}') constructed`);
  }

  /** Whether this source connects to a remote MCP server (HTTP/SSE). */
  isRemote(): boolean {
    return this.mode.type === "remote";
  }

  async start(): Promise<void> {
    // Fresh stderr state on every start. Restart cycles must not bleed
    // a dead instance's tail into the new instance's crash report.
    this.stderrTail = [];
    this.stderrLineBuf = "";
    // Clear deliberate-teardown flags so a restart re-enables crash detection
    // on the new transport. Set in `stop()` to suppress onclose-emitted
    // `source.crashed` events during graceful teardown.
    this.stopping = false;
    this.stopped = false;

    if (this.mode.type === "stdio") {
      const stdioTransport = new StdioClientTransport({
        command: this.mode.spawn.command,
        args: this.mode.spawn.args,
        env: this.mode.spawn.env,
        cwd: this.mode.spawn.cwd,
        stderr: "pipe",
      });
      this.transport = stdioTransport;

      // Attach the stderr drain BEFORE connect. The SDK exposes
      // `transport.stderr` as a PassThrough synchronously from the
      // constructor (see node_modules/.../client/stdio.js — the comment
      // there explicitly notes this is to avoid losing early child output),
      // so listeners attached now will catch bytes written during
      // initialize-time crashes.
      // SDK types `stderr` as bare `Stream | null`, but the actual return
      // is always a Node Readable (`PassThrough` when piped, otherwise
      // `child_process.stderr`). Narrow at the boundary.
      this.attachStderrReader(stdioTransport.stderr as NodeJS.ReadableStream | null);

      // Stdio close handler. The SDK's Protocol.connect() chains existing
      // onclose handlers (it captures the prior callback and calls it
      // before its own _onclose), so setting this before connect is
      // correct and survives the handshake. Without this handler, a
      // subprocess that exits mid-session is only detected lazily inside
      // execute()'s catch branch — issue #116 root cause #2.
      stdioTransport.onclose = () => this.emitSourceCrashed("Stdio subprocess exited");
    } else if (this.mode.type === "remote") {
      this.transport = createRemoteTransport(
        this.mode.url,
        this.mode.transportConfig,
        this.mode.authProvider,
        {
          workspaceId: this.bundleContext?.workspaceId,
          allowInsecure: this.mode.allowInsecure ?? false,
        },
      );

      // Remote: watch for transport close — wired AFTER successful start
      // (in `start()` below) rather than here, so transport closures that
      // happen during the start handshake (SDK 401 → provider throws
      // UnauthorizedError → SDK closes transport) don't get classified as
      // `source.crashed` — they're start failures handled by the catch
      // branch + the OAuth retry path. Setting it here would race with
      // that retry: the close fires before McpSource catches
      // `UnauthorizedError`, marks the source dead, and HealthMonitor
      // starts restart attempts that fight our own retry.
    } else {
      // In-process: the factory builds a fresh InMemoryTransport pair and an
      // already-connected Server on each call, so restart is a clean slate.
      // We hold the Server so `stop()` can close it explicitly — without that
      // the pair-side close still works, but the Server's internal handler
      // tables hang on until GC.
      const { server, clientTransport } = await this.mode.createServer();
      this.inProcessServer = server;
      this.transport = clientTransport;

      this.transport.onclose = () => this.emitSourceCrashed("In-process transport closed");
    }

    // Advertise client-side tasks capability per MCP spec draft 2025-11-25:
    // servers with `execution.taskSupport` on any tool see that this client
    // honors task-augmented `tools/call` and will attach `params.task: {ttl}`
    // when calling those tools. The engine then polls via tasks/get and
    // retrieves via tasks/result instead of blocking the request.
    //
    // The `extensions` block carries NimbleBrain-namespaced vendor
    // capabilities (e.g. `ai.nimblebrain/host-resources`) per the MCP
    // extensions spec — https://modelcontextprotocol.io/extensions/overview.
    // Bundles read these from their ClientCapabilities to opt into
    // bundle→host resource reads. Phase 1 advertises the capability;
    // handlers land in Phase 2.
    this.client = new Client(
      { name: "nimblebrain", version: "0.1.0" },
      {
        capabilities: {
          tasks: {
            requests: { tools: { call: {} } },
            cancel: {},
            list: {},
          },
          extensions: hostExtensions(),
        },
      },
    );
    // Inbound host-resources handlers registered before connect so they're
    // ready the moment the bundle issues its first request. No-op for
    // in-process sources that don't pass a bundleContext.
    this.registerBundleHandlers(this.client);
    // Native `tools/list_changed` subscription — must be on the client before
    // connect so a notification arriving immediately after `initialize` isn't
    // dropped.
    this.registerToolsChangedHandler(this.client);

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
          //
          // Clear the onclose handler before close — the existing handler
          // marks the source dead and emits source.crashed, which would
          // race with the retry path: the upcoming HealthMonitor sweep
          // would see `dead === true` and try to restart, fighting our
          // own retry. Re-attached on the new transport in
          // `rebuildRemoteTransport`.
          if (this.transport) this.transport.onclose = undefined;
          await this.cleanupOnStartFailure();
          this.rebuildRemoteTransport();
          this.client = this.buildClient();
          // Re-register inbound host-resources handlers on the rebuilt
          // Client — handler tables don't carry over from the prior
          // instance.
          this.registerBundleHandlers(this.client);
          this.registerToolsChangedHandler(this.client);
          // Re-arm crash detection for the retry: cleanupOnStartFailure
          // set `stopping = true` to suppress its own teardown noise; we
          // need it false again before the new transport's onclose can
          // fire usefully. If this retry connect also fails, the catch
          // below calls cleanupOnStartFailure again and re-suppresses.
          this.stopping = false;

          await this.connectWithTimeout(CONNECT_TIMEOUT);
          this.startedAt = Date.now();
          // This early-return is a SECOND success seam (the headless OAuth
          // auto-resolve retry). The source is now enumerable, so it must emit
          // the same tools-changed signal as the bottom seam — otherwise a
          // union memoized while a remote OAuth source was unreachable (e.g.
          // `tryRestart` re-auth, or a union cached between addSource and
          // connect-completion on a post-boot startAuth) stays stale: the exact
          // bug this signal exists to kill, on the one branch that skipped it.
          // FOLLOW-UP: this branch also skips `dead = false`, the onclose
          // rewiring, instructions capture, and `startTaskSweeper()` from the
          // bottom seam — a pre-existing asymmetry (tracked separately). The
          // right long-term shape is to converge this path onto the bottom seam
          // instead of early-returning.
          this.emitToolsChanged();
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

    // Now that start has succeeded, wire transport close-detection.
    // Closes from this point on indicate a real mid-session disconnect
    // (server crashed, network drop, idle timeout) and should mark the
    // source dead so HealthMonitor can take over.
    if (this.transport && this.mode.type === "remote") {
      this.transport.onclose = () => this.emitSourceCrashed("Remote transport closed");
    }

    // Capture the server's initialize `instructions` field (may be undefined).
    // The MCP SDK stores it internally; we expose it via getInstructions() so
    // the system prompt composer can render it in the apps list.
    const instructions = this.client.getInstructions();
    this._instructions = typeof instructions === "string" ? instructions : undefined;

    // Capture the server's reported version (serverInfo.version, from the same
    // initialize response). The server is untrusted — a Composio gateway or a
    // third-party OAuth server controls this string — so strip control chars and
    // cap length before storing. Display-only; never a security signal. A server
    // that sets no version reports its framework's instead; that's still what it
    // claims, so we keep it and let the UI decide (running version primary,
    // catalog version shown only on drift).
    const reportedVersion = this.client.getServerVersion()?.version;
    this._serverVersion =
      typeof reportedVersion === "string" ? sanitizeReportedVersion(reportedVersion) : undefined;

    this.startTaskSweeper();

    // Connect succeeded — this source's tools are now enumerable where a
    // moment ago `tools()` would have thrown "not started". This is the
    // signal the cross-workspace tool-list aggregator needs: a union memoized
    // while we were unreachable (slow cold-start, crash + HealthMonitor
    // restart, deferred/pending-auth start) is now stale and must be dropped.
    // This is the PRIMARY success seam (initial start + `tryRestart`); the
    // OAuth-retry early-return above is the secondary seam and emits there too.
    // Cheap and idempotent downstream: invalidation is a no-op when nothing is
    // cached yet (e.g. during boot, before any request has populated the union).
    this.emitToolsChanged();
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
    // A start that never reached the "running" state is not a crash —
    // the caller is about to throw the real error. Suppress the
    // `source.crashed` event that would otherwise fire when
    // `transport.close()` triggers our onclose handler. Without this,
    // every failed connect would emit a parallel crash event for a
    // source the listener has never seen "running."
    this.stopping = true;
    try {
      if (this.transport) await this.transport.close();
      if (this.inProcessServer) await this.inProcessServer.close();
    } catch (cleanupErr) {
      log.error("[mcp-source] transport cleanup failed", {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    this.client = null;
    this.transport = null;
    this.inProcessServer = null;
  }

  /**
   * Single emit point for `source.crashed`. Two guards, two invariants:
   *
   *   - `stopping` — set in `stop()` and `cleanupOnStartFailure()`. The
   *     SDK fires `transport.onclose` synchronously inside
   *     `transport.close()`, so without this guard every deliberate
   *     teardown would surface as a crash event.
   *
   *   - `dead` — set on first death-observation. The transport's
   *     `onclose` and `execute()`'s catch can BOTH observe a single
   *     subprocess death (the call throws because the pipe broke; the
   *     subprocess exit also fires onclose). Without this guard,
   *     listeners would see two `source.crashed` events for one death,
   *     which any deduplicating consumer (UI, telemetry) gets wrong.
   *     Whichever path runs first wins; its payload is canonical.
   *
   * `stderrTail` is sourced from the ring buffer, so it's empty for
   * non-stdio modes (which never populate it) and populated for stdio
   * regardless of which path triggered the emit.
   */
  private emitSourceCrashed(error: string): void {
    if (this.stopping || this.dead) return;
    this.dead = true;
    this.eventSink.emit({
      type: "run.error",
      data: {
        source: this.name,
        event: "source.crashed",
        error,
        stderrTail: this.stderrTail.join("\n"),
      },
    });
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
      {
        workspaceId: this.bundleContext?.workspaceId,
        allowInsecure: this.mode.allowInsecure ?? false,
      },
    );
    // onclose is wired in `start()` AFTER the connect succeeds — same
    // reason as the initial-construction site: a transport close that
    // happens during the retry's connect handshake is part of the start
    // flow, not a mid-session crash. The OAuth retry path that calls
    // this method is precisely the case we want NOT to surface as
    // `source.crashed`.
  }

  /**
   * Drain the stdio subprocess's stderr stream into the developer's
   * terminal and a bounded in-memory ring buffer.
   *
   * Why default-on (not gated behind `NB_DEBUG`): bundle stderr is the
   * bundle author's deliberate diagnostic output — tracebacks, warnings,
   * runtime logs. That's a different concern than NB's own protocol
   * tracing (`NB_DEBUG=mcp`). Hiding signal that costs hours to recreate
   * (issue #116) is a worse default than dimmed lines a developer can
   * scan past or silence at the bundle level. Visual prefix + dim
   * formatting via `log.bundle` makes the channel tunable by eye.
   *
   * Why a ring buffer in addition to live print: when the subprocess
   * exits, the `transport.onclose` handler attaches `stderrTail` to the
   * outgoing `source.crashed` event so non-CLI consumers (web UI later,
   * persisted event logs) can render the cause-of-death without us
   * keeping the entire log around.
   *
   * Stream contract: `transport.stderr` is a Node-style Readable
   * (PassThrough in the SDK). Listeners attached here run for the
   * lifetime of the subprocess; the stream's `end` event fires on
   * subprocess exit and the listeners are released by the transport's
   * own teardown — no explicit unsubscribe needed.
   */
  private attachStderrReader(stream: NodeJS.ReadableStream | null): void {
    if (!stream) return;
    const decoder = new TextDecoder("utf-8", { fatal: false });

    stream.on("data", (chunk: unknown) => {
      let text: string;
      if (typeof chunk === "string") {
        text = chunk;
      } else if (chunk instanceof Uint8Array) {
        text = decoder.decode(chunk, { stream: true });
      } else {
        text = String(chunk);
      }
      this.stderrLineBuf += text;

      // Drain complete lines.
      let nl = this.stderrLineBuf.indexOf("\n");
      while (nl !== -1) {
        let line = this.stderrLineBuf.slice(0, nl);
        this.stderrLineBuf = this.stderrLineBuf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        this.recordStderrLine(line);
        nl = this.stderrLineBuf.indexOf("\n");
      }

      // Guard against an unbounded line — flush whatever we have, marked.
      if (this.stderrLineBuf.length > STDERR_LINE_MAX_CHARS) {
        const truncated = `${this.stderrLineBuf.slice(0, STDERR_LINE_MAX_CHARS)} […truncated]`;
        this.stderrLineBuf = "";
        this.recordStderrLine(truncated);
      }
    });

    // Stream end: flush any pending bytes from the decoder + line buffer
    // so a `print(end="")`-style final write is not silently dropped.
    stream.on("end", () => {
      const trailing = decoder.decode();
      if (trailing) this.stderrLineBuf += trailing;
      if (this.stderrLineBuf.length > 0) {
        this.recordStderrLine(this.stderrLineBuf);
        this.stderrLineBuf = "";
      }
    });

    // Don't crash the host on a stream-level error from the pipe — log
    // and let the subprocess's own close path handle source death.
    stream.on("error", (err: unknown) => {
      log.debug("mcp", `[${this.name}] stderr stream error: ${String(err)}`);
    });
  }

  /** Push one logical stderr line: live render + ring buffer. */
  private recordStderrLine(line: string): void {
    if (line.length === 0) return;
    const capped =
      line.length > STDERR_LINE_MAX_CHARS
        ? `${line.slice(0, STDERR_LINE_MAX_CHARS)} […truncated]`
        : line;
    log.bundle(this.name, capped);
    this.stderrTail.push(capped);
    if (this.stderrTail.length > STDERR_TAIL_MAX_LINES) {
      this.stderrTail.shift();
    }
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
          extensions: hostExtensions(),
        },
      },
    );
  }

  /**
   * Register inbound handlers for the host-resources extension methods.
   * Called once per Client lifecycle — after `new Client()` (initial
   * start) and after `buildClient()` (OAuth retry rebuild). No-op when
   * `bundleContext` is absent (in-process platform sources don't need
   * the surface).
   *
   * Handlers do three things, in order: rate-limit check (throws
   * `-32004` on exhaustion), delegate to the resolver (which enforces
   * scheme allowlist + workspace isolation + size cap), and log via
   * the `host-resources` debug namespace. Errors propagate as JSON-RPC
   * errors back to the bundle.
   */
  private registerBundleHandlers(client: Client): void {
    const ctx = this.bundleContext;
    if (!ctx) return;

    client.setRequestHandler(NbReadResourceRequestSchema, async (request) => {
      ctx.rateLimit.check(ctx.workspaceId, ctx.bundleId);
      return ctx.hostResources.read(request.params.uri, {
        workspaceId: ctx.workspaceId,
        bundleId: ctx.bundleId,
      });
    });

    client.setRequestHandler(NbListResourcesRequestSchema, async (request) => {
      ctx.rateLimit.check(ctx.workspaceId, ctx.bundleId);
      const params = request.params ?? {};
      return ctx.hostResources.list(
        // Bundle-supplied filter rides in `_meta` per MCP convention for
        // extension-carried request data — spec `ListResourcesRequest`
        // doesn't have a `filter` field. If the spec ever adds one, also
        // accept it from `params.filter` here.
        {
          cursor: typeof params.cursor === "string" ? params.cursor : undefined,
          filter:
            ((params._meta as Record<string, unknown> | undefined)?.filter as
              | { scheme?: string; mimeType?: string; tags?: string[] }
              | undefined) ?? undefined,
        },
        { workspaceId: ctx.workspaceId, bundleId: ctx.bundleId },
      );
    });
  }

  /**
   * Register the client-side handler for the server's native
   * `notifications/tools/list_changed`. Per the MCP spec the server emits
   * this whenever its advertised tool set changes at runtime (dynamic tool
   * registration); on receipt the client MUST treat its cached list as stale.
   * We drop `cachedTools` (so the next `tools()` re-fetches via `tools/list`)
   * and fan out to subscribers so any memoized projection invalidates.
   *
   * Called once per Client lifecycle — after `new Client()` (initial start)
   * and after `buildClient()` (OAuth retry rebuild) — because handler tables
   * don't carry across SDK Client instances. Unlike `registerBundleHandlers`
   * this runs for every source (in-process platform sources included): any
   * MCP server may push the notification.
   */
  private registerToolsChangedHandler(client: Client): void {
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.cachedTools = null;
      this.emitToolsChanged();
    });
  }

  /**
   * Subscribe to tool-set-change signals (connect/restart/deferred-start/
   * native list_changed). Returns an unsubscribe function. See
   * {@link ToolSource.subscribeToolsChanged}.
   */
  subscribeToolsChanged(listener: () => void): () => void {
    this.toolsChangedListeners.add(listener);
    return () => {
      this.toolsChangedListeners.delete(listener);
    };
  }

  /** Fan out a tool-set-change signal to subscribers, isolating failures. */
  private emitToolsChanged(): void {
    for (const listener of this.toolsChangedListeners) {
      try {
        listener();
      } catch (err) {
        log.debug(
          "mcp",
          `[${this.name}] toolsChanged listener threw — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Check if the transport is still connected. */
  isAlive(): boolean {
    return this.transport !== null && this.client !== null && !this.dead;
  }

  /**
   * Whether this source was deliberately stopped via `stop()` (teardown /
   * disconnect) and not since restarted. `HealthMonitor` uses this to avoid
   * reconnecting an orphaned, registry-removed instance — see the field doc on
   * {@link stopped}. A self-dropped transport (idle close, network blip) leaves
   * this false, so it still reconnects.
   */
  isStopped(): boolean {
    return this.stopped;
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
    // Tell our onclose handlers this is a deliberate teardown — see
    // `stopping` field. Without this, every graceful stop would emit a
    // `source.crashed` event when `transport.close()` triggers onclose.
    this.stopping = true;
    // Distinct durable marker for "deliberately stopped" (vs the failed-start
    // `stopping` that `cleanupOnStartFailure` also sets). Cleared by `start()`.
    this.stopped = true;
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
      log.error("[mcp-source] stop failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.client = null;
    this.transport = null;
    this.inProcessServer = null;
    this.cachedTools = null;
    this._instructions = undefined;
    this._serverVersion = undefined;
  }

  /** Server `instructions` string from the MCP `initialize` response.
   *  Undefined until start() completes; cleared by stop(). */
  getInstructions(): string | undefined {
    return this._instructions;
  }

  /** Sanitized `serverInfo.version` from the MCP `initialize` response.
   *  Undefined until start() completes, if the server reports none, or after
   *  stop(). Display-only — the server is untrusted. */
  getReportedVersion(): string | undefined {
    return this._serverVersion;
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

    // Recover string-encoded structured args against THIS server's own
    // advertised schema, then strip no-op optional values — both keyed off
    // `tool.inputSchema`, the schema this source advertised at `tools/list`.
    //
    // Coerce first: models routinely emit object/array parameters as
    // JSON-encoded strings (`to_recipients: "[\"a@b.com\"]"` instead of the
    // array). The engine runs the same coercion against the schema it built
    // for the LLM, but that view can diverge from this source's live schema
    // (search-promoted tools, cross-workspace dispatch) — and any divergence
    // means a stringified array reaches the wire and the upstream validator
    // rejects it ("Input should be a valid list on parameter to_recipients").
    // Re-coercing here, at the dispatch boundary, against the source's own
    // schema closes that gap for every call routed through `execute` — the
    // agent loop's inline and task-augmented paths both flow through here.
    // `coerceInputForSchema` is pure and idempotent: an already-correct array
    // survives unchanged, so the redundant engine-side pass is harmless.
    //
    // Scope: this covers the `execute` path only. The external `/mcp` task
    // surface dispatches via `startToolAsTask` directly (see mcp-server.ts),
    // bypassing this; that path is folded into the separate `/mcp` overhaul (#423).
    // Limitation: coercion is a no-op when the array/object param is expressed
    // via `$ref`/`allOf` (see `coerce-input.ts`) — Composio's flat `type:
    // "array"` schemas are covered; richer shapes are tracked in #424.
    //
    // Order matters: coerce before scrub so a stringified empty array
    // (`"[]"`) becomes `[]` and is then eligible for no-op stripping.
    const coerced = tool?.inputSchema ? coerceInputForSchema(input, tool.inputSchema) : input;

    // Strip no-op values models routinely emit for optional fields (empty
    // strings, nil UUIDs, empty arrays). Some upstream APIs treat these as
    // real values and reject with HTTP 400. Equivalent to the model having
    // omitted the field. Required fields pass through unchanged.
    const scrubbed = tool?.inputSchema
      ? scrubArgsForDispatch(coerced, tool.inputSchema)
      : { args: coerced, stripped: [] };
    if (scrubbed.stripped.length > 0) {
      log.debug(
        "mcp",
        `scrub source=${this.name} tool=${toolName} stripped=${scrubbed.stripped.join(",")}`,
      );
    }
    const dispatchArgs = scrubbed.args;

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
      return await withSpan(
        "tool.dispatch",
        {
          "tool.name": toolName,
          "tool.source": this.name,
          "tool.path": isTaskAugmented ? "task-augmented" : "inline",
          ...requestIdentityAttrs(),
        },
        () =>
          isTaskAugmented
            ? this.callToolAsTask(toolName, dispatchArgs, signal)
            : this.callToolInline(toolName, dispatchArgs, signal),
        // A client cancellation isn't a crash — don't mark the span failed.
        { isExpectedError: () => signal?.aborted === true },
      );
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

      // One recovery path for every outbound op. `recover` classifies the throw,
      // consults `policyFor`, and effects the action (surface / reauth / restart
      // + retry with bounded backoff). Two op-specific facts come from here:
      //
      //  - `idempotent: !isTaskAugmented` — a task-augmented call has spawned
      //    server-side state (the task, an entity, side effects); retrying would
      //    duplicate it. So `policyFor` surfaces every failure for tasks rather
      //    than retrying. Inline calls are re-issued with the SCRUBBED args
      //    (`dispatchArgs`), same as the direct call — the original `input` may
      //    carry no-op sentinels an upstream API rejects.
      //  - `reauth` — a remote with an OAuth provider flips to `reauth_required`
      //    and shows a structured "Reconnect"; a static-auth remote (no provider)
      //    has nothing to re-run, so `policyFor` surfaces it as a normal error.
      const failMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
      return this.recover<ToolResult>(
        err,
        () => this.callToolInline(toolName, dispatchArgs, signal),
        {
          idempotent: !isTaskAugmented,
          // A throw on a tools/call is almost always the transport; recover even
          // unrecognized shapes (old robustness), but only ONCE — see
          // TOOL_CALL_RECOVERY_DELAYS — so a mutating call isn't replayed N times.
          recoverUnknown: true,
          delays: TOOL_CALL_RECOVERY_DELAYS,
          surface: (e) => ({
            content: textContent(
              isTaskAugmented
                ? `Task failed and cannot be auto-retried: ${failMsg(e)}`
                : `${this.name} call failed: ${failMsg(e)}`,
            ),
            isError: true,
          }),
          reauth: () => ({
            content: textContent(
              `${this.name} needs to be reconnected — its authorization has expired. Open the connector and click Reconnect.`,
            ),
            isError: true,
            structuredContent: {
              error: "auth_required",
              reason: "reauth_required",
              source: this.name,
            },
          }),
        },
      );
    }
  }

  /**
   * Shared recovery for a failed outbound op — the single place recovery
   * semantics live (both `execute` and `readResource` route their catch here).
   * Classifies the throw via `classifyConnectionFailure` (op-INDEPENDENT),
   * consults `policyFor`, and effects the action:
   *
   *  - **surface** — give up; return the caller's terminal representation.
   *  - **reauth** — flip the connection to `reauth_required` (`notifyAuthLost`),
   *    then surface the caller's reauth representation.
   *  - **recover** — re-establish (`tryRestart`, single-flight) and retry the op,
   *    riding a remote roll with bounded backoff; on exhaustion, mark the source
   *    crashed so HealthMonitor's longer backoff takes over, then surface.
   *
   * Op-scoped outcomes (a genuine resource miss) short-circuit via `shape.miss`
   * before any recovery — those are application answers, not connection failures.
   * The op-specific terminal shapes (a `ToolResult` vs a `ResourceData | null`)
   * come from `shape`. See research/SPEC-mcp-source-recovery.md §3.3.
   */
  private async recover<T>(
    firstErr: unknown,
    op: () => Promise<T>,
    shape: {
      idempotent: boolean;
      /** How to treat an `unknown` (unclassifiable) throw. Tool calls set this so
       *  an unrecognized transport error still recovers (old "restart on any
       *  throw" robustness); reads leave it false so a malformed result / 429 /
       *  server code surfaces instead of restart-storming the whole source. */
      recoverUnknown: boolean;
      /** Per-call-site backoff schedule. Tool calls pass a single immediate
       *  attempt (`TOOL_CALL_RECOVERY_DELAYS`) to preserve the historical
       *  one-retry budget — a non-idempotent mutating call must NOT be replayed
       *  several times. Reads pass the wider roll-window schedule. The test seam
       *  `recoveryDelaysMs` overrides both. */
      delays: readonly number[];
      surface: (err: unknown) => T;
      reauth: (err: unknown) => T;
      miss?: (err: unknown) => T;
    },
  ): Promise<T> {
    const hasReauthableProvider = this.mode.type === "remote" && this.mode.authProvider != null;
    const delays = this.recoveryDelaysMs ?? shape.delays;
    let err = firstErr;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      // The server answered "not here" — an application outcome, not a connection
      // failure. Checked each iteration (only reads pass `miss`): a genuine miss
      // discovered AFTER a successful re-establish stays a silent null, matching
      // the pre-unification behavior, instead of logging a spurious read failure.
      if (shape.miss && isMcpResourceMiss(err)) return shape.miss(err);
      const classified = classifyConnectionFailure(err);
      // An `unknown` throw is recoverable only where the caller opts in (tool path);
      // elsewhere it's surfaced like a protocol error.
      const kind =
        classified === "unknown" ? (shape.recoverUnknown ? "transport-dead" : "none") : classified;
      if (kind === "none") return shape.surface(err); // app/protocol/unknown — don't restart
      const action = policyFor(kind, { idempotent: shape.idempotent, hasReauthableProvider });
      if (action === "reauth") {
        if (this.mode.type === "remote" && this.mode.authProvider) {
          this.mode.authProvider.notifyAuthLost();
        }
        return shape.reauth(err);
      }
      if (action === "surface") {
        // Giving up on a genuine connection failure we won't retry (a
        // non-idempotent op — e.g. a task-augmented call whose transport broke).
        // Mark the source crashed so HealthMonitor heals it for later calls; the
        // transport is actually broken even though we don't retry this call.
        // `auth-lost` is a credential problem, not a transport crash — excluded,
        // so a static-auth 401 surfaces without thrashing restarts.
        if (kind !== "auth-lost") this.emitSourceCrashed(String(err));
        return shape.surface(err);
      }
      // action === "recover": re-establish + retry, riding the roll window.
      if (attempt === delays.length) break; // out of attempts
      const delayMs = delays[attempt] ?? 0;
      if (delayMs > 0) await sleep(delayMs);
      if (!(await this.tryRestart())) continue; // server still rolling — back off
      try {
        return await op();
      } catch (retryErr) {
        err = retryErr; // re-classify on the next iteration
      }
    }

    // Recovery exhausted. A stale session never closed the transport, so the
    // source still reports `isAlive()` — mark it crashed so HealthMonitor's
    // longer exponential backoff sweeps it (it only acts on a not-alive source).
    this.emitSourceCrashed(
      `recovery exhausted: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}`,
    );
    return shape.surface(err);
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
  async readResource(uri: string, opts?: { logFailures?: boolean }): Promise<ResourceData | null> {
    if (!this.client) {
      // A torn-down client (a source degraded/crashed without re-creation)
      // returns null HERE, before the catch below — the persistent silent-404
      // shape this change exists to surface, and the most likely cause of a read
      // that stays broken until a full runtime restart. Log it on the app-surface
      // path; the probe path stays silent because a not-yet-started or tearing-down
      // source legitimately has no client during composition.
      if (opts?.logFailures) {
        log.warn("[mcp] readResource: source has no active client connection", {
          uri,
          source: this.name,
        });
      }
      return null;
    }
    // A real failure (a torn transport, a dropped connection, an exhausted
    // recovery) is NOT a missing resource — log it ONLY on the app-surface path
    // (the resource proxy passes `logFailures`), where a failure is anomalous.
    // Discovery probes stay silent so a bundle that simply lacks a probed
    // resource never spams. The null (404) is preserved either way; this only
    // makes the anomalous case visible.
    const logAndNull = (err: unknown): null => {
      if (opts?.logFailures) {
        log.warn("[mcp] readResource failed", {
          uri,
          source: this.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    };
    try {
      return this.toResourceData(await this.client.readResource({ uri }));
    } catch (err) {
      // Route every failure through the shared recovery. A genuine MCP miss
      // (`shape.miss`) stays a silent null — e.g. a skill:// or app://instructions
      // probe against a server that has neither. A stale session / mid-roll
      // gateway blip / torn transport re-initializes and retries (issue #571);
      // an auth loss flips the connection to `reauth_required`. Reads are
      // idempotent, so they retry across the deploy window.
      return this.recover<ResourceData | null>(
        err,
        async () => {
          if (!this.client) throw err; // restart produced no client — keep recovering
          return this.toResourceData(await this.client.readResource({ uri }));
        },
        {
          idempotent: true,
          // Reads are conservative on unclassifiable errors: a malformed result
          // (ZodError), a 429, or a server-defined code must NOT restart-storm the
          // whole source — surface it as a null. Recognized transport failures and
          // session loss still recover across the deploy window.
          recoverUnknown: false,
          delays: SESSION_RECOVERY_DELAYS_MS,
          miss: () => null,
          surface: logAndNull,
          reauth: logAndNull,
        },
      );
    }
  }

  /**
   * Project an MCP `resources/read` result into `ResourceData`, or null for an
   * empty result. Preserves `_meta` from both the per-content entry and the
   * result level (per-content wins on overlap — the ext-apps spec attaches ui
   * metadata at the content level).
   */
  private toResourceData(result: Awaited<ReturnType<Client["readResource"]>>): ResourceData | null {
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
    const toolResult: ToolResult = {
      content: Array.isArray(result.content) ? (result.content as ContentBlock[]) : [],
      structuredContent: (result as Record<string, unknown>).structuredContent as
        | Record<string, unknown>
        | undefined,
      isError: Boolean(result.isError),
      // Surface result-level `_meta` (loose object on the wire) so out-of-band
      // hints from the bundle — e.g. the supervisor's non-advancing marker —
      // reach the engine instead of being dropped at this projection.
      _meta: (result as { _meta?: Record<string, unknown> })._meta,
    };
    const promoted = promoteHiddenErrors(toolResult);
    if (promoted !== toolResult) {
      log.debug("mcp", `lie-normalized source=${this.name} tool=${toolName} path=inline`);
    }
    return promoted;
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

    const toolResult: ToolResult = {
      content: Array.isArray(callToolResult.content)
        ? (callToolResult.content as ContentBlock[])
        : [],
      structuredContent: callToolResult.structuredContent as Record<string, unknown> | undefined,
      isError: Boolean(callToolResult.isError),
      // Surface result-level `_meta` (loose object on the wire) so out-of-band
      // hints from the bundle reach the engine — same as the inline path.
      _meta: (callToolResult as { _meta?: Record<string, unknown> })._meta,
    };
    const promoted = promoteHiddenErrors(toolResult);
    if (promoted !== toolResult) {
      log.debug("mcp", `lie-normalized source=${this.name} tool=${toolName} path=task`);
    }
    return promoted;
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

            // Defense in depth: the upstream MCP SDK's task stream emits
            // `type: 'error'` with an `McpError(InternalError, "Task <id>
            // failed")` whenever the server-side task status is `failed`,
            // AND discards the server's `tasks/result` payload along the
            // way. A bundle that misclassified its own terminal status —
            // e.g., a post-result exception flipping COMPLETED→FAILED
            // while a usable payload already existed in the store — would
            // surface to the agent as a useless string with the real
            // output gone. Try one extra fetch before settling for the
            // generic error.
            //
            // Discriminator: `endsWith` on the known `handle.taskId`,
            // NOT a regex on the bare message. McpError's constructor
            // wraps the message as `"MCP error <code>: <message>"` (see
            // node_modules/@modelcontextprotocol/sdk/.../types.js), so
            // the production `error.message` is "MCP error -32603:
            // Task <id> failed" — anchored regexes against the bare
            // form silently fail to match and the recovery is a no-op.
            // Using the taskId as the discriminator also tightens
            // specificity: we won't accidentally recover on a bundle-
            // authored error that happens to mention a different task.
            let recoveredResult: CallToolResult | null = null;
            const isGenericTaskFailed = errMessage.endsWith(`Task ${handle.taskId} failed`);
            if (!isAborted && this.client && isGenericTaskFailed) {
              try {
                recoveredResult = await this.client.experimental.tasks.getTaskResult(
                  handle.taskId,
                  CallToolResultSchema,
                );
                log.debug(
                  "mcp",
                  `recovered tasks/result for failed task ${handle.taskId} on ${this.name}`,
                );
              } catch {
                // No result genuinely available — fall through to the
                // generic-error path below.
              }
            }

            const callToolResult: CallToolResult = recoveredResult ?? {
              content: [{ type: "text", text: errMessage }],
              isError: true,
            };
            handle.terminal = { result: callToolResult };
            // Contract: even when we recover a payload, `latestTask.status`
            // reflects what the SERVER reported (`failed`/`cancelled`).
            // The recovery only salvages the agent-visible content; we
            // don't rewrite the server's terminal verdict. Status
            // consumers (UI progress, postmortem inspection) see the
            // honest server state; the agent sees the actual output.
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

  /**
   * Test-only — drive the stderr reader against a synthetic Readable so
   * tests can exercise chunk-boundary, CRLF, partial-line, and runaway-
   * line handling without spawning a real subprocess.
   * Production code MUST NOT call this.
   */
  _attachStderrReaderForTesting(stream: NodeJS.ReadableStream): void {
    this.attachStderrReader(stream);
  }

  /** Test-only — read the current stderr ring-buffer contents. */
  _stderrTailForTesting(): readonly string[] {
    return this.stderrTail;
  }

  /** Test-only — observe `dead` to verify the de-dup guard. */
  _isDeadForTesting(): boolean {
    return this.dead;
  }

  /**
   * Test-only — directly invoke the crash emitter to verify de-dup
   * (second call must be a no-op once `dead` is set).
   * Production code MUST NOT call this.
   */
  _emitSourceCrashedForTesting(error: string): void {
    this.emitSourceCrashed(error);
  }

  private async tryRestart(): Promise<boolean> {
    // Coalesce concurrent restarts behind one in-flight stop()/start() cycle —
    // inline session recovery (readResource / callTool) and HealthMonitor can
    // all reach here for the same source after a remote roll. See `restartInFlight`.
    if (this.restartInFlight) return this.restartInFlight;
    this.restartInFlight = this.doRestart();
    try {
      return await this.restartInFlight;
    } finally {
      this.restartInFlight = null;
    }
  }

  private async doRestart(): Promise<boolean> {
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

/**
 * Distinguish a genuine "the resource is not here" outcome from a transport /
 * connection failure, for `readResource`'s catch.
 *
 * A JSON-RPC application error means the server received the request and
 * answered — it is alive, the resource simply isn't (or isn't readable) there,
 * and restarting the transport would not change the answer:
 *   - `-32002` ResourceNotFound (the spec code; see host-resources/resolver.ts),
 *   - `-32601` MethodNotFound (server advertises no resources capability),
 *   - `-32602` InvalidParams (unknown / unsupported URI).
 * Some servers signal a miss only in the message, so match that as a fallback.
 *
 * A torn transport (connection closed `-32000`, timeout, fetch failure) is none
 * of these — it carries no application error code — so it returns `false` and
 * must NOT be masked as a missing resource.
 */
export function isMcpResourceMiss(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === -32002 || code === -32601 || code === -32602) return true;
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /resource not found|unknown resource|no such resource/i.test(message)
  );
}

/**
 * The **connection-level** failure classes — properties of the source's
 * connection, independent of which op (`tools/call`, `resources/read`, …) threw.
 * This is the only thing classifiable from a throw regardless of op. The
 * application-outcome question ("server answered, but with a miss / an error?")
 * is op-DEPENDENT — the same wire code (`-32601`, `-32602`) is a resource miss on
 * `resources/read` but a method/param error on `tools/call` — so it lives in a
 * separate, op-scoped classifier (`isMcpResourceMiss` for reads), NOT here. See
 * `research/SPEC-mcp-source-recovery.md` §3.1.
 *
 * `source-absent` (a registry-lookup miss before any call) and `credential-lost`
 * (a `ConnectionRevalidator` probe verdict) are deliberately absent: they are not
 * thrown errors, so they cannot be classified from one. They reach recovery as
 * detector *signals* (handled by the recovery policy in Phase 2), never as
 * outputs of `classifyConnectionFailure`.
 */
export type ConnectionFailure =
  | "session-lost"
  | "transient"
  | "transport-dead"
  | "auth-lost"
  | "unknown"
  | "none";

/**
 * Classify a thrown error into a connection-failure class. Order matters:
 * `session-lost` and `transient` are checked first (most specific), then
 * `auth-lost`, then the standard protocol codes, then recognized torn-transport
 * shapes, with `unknown` as the residue.
 *
 * - **session-lost** — the server forgot our Streamable-HTTP session (it rolled).
 *   Wire shape (NOT a JSON-RPC code on `err.code`): a request on a stale
 *   `Mcp-Session-Id` gets HTTP 404 + a `-32001 "Session not found"` body, which the
 *   SDK throws as a `StreamableHTTPError` whose `.code` is the status (404) and
 *   whose `.message` carries the `-32001`/text. Match status + message together; a
 *   code-only match on -32001 silently never fires on the canonical path.
 * - **transient** — a mid-roll gateway blip (502/503/504, `bad_gateway`). Back off.
 * - **auth-lost** — a rejected credential. Detectable only as `UnauthorizedError`;
 *   note its recovery *policy* is config-dependent — a static-auth remote can't
 *   reauth — but that decision is Phase 2's (see the SPEC §3.2), not this function's.
 * - **transport-dead** — a RECOGNIZED torn-transport shape (closed / refused /
 *   reset / timed out / fetch error / broken pipe).
 * - **none** — the server answered with a standard JSON-RPC *protocol* error
 *   (parse/invalid-request/method/params/internal, or resource-not-found), or a
 *   non-object throw. A restart won't change the answer; surface it. App-level
 *   tool failures don't reach here at all — they come back as `isError` *results*.
 * - **unknown** — a throw we can't positively classify. The caller decides: the
 *   tool path treats it as recoverable (old "restart on any throw" robustness,
 *   now capped); the read path surfaces it (a malformed result / 429 / server
 *   code must NOT restart-storm the whole source). This split is why `unknown` is
 *   distinct from `transport-dead` — see `recover`'s `recoverUnknown`.
 */
export function classifyConnectionFailure(err: unknown): ConnectionFailure {
  if (err === null || typeof err !== "object") return "none";
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  const msg = typeof message === "string" ? message : "";

  // session-lost — exact prior `isSessionLost` logic, checked first. NOTE the SDK
  // also uses -32001 for RequestTimeout; a timeout is recover-eligible too, so the
  // overlap is benign — but the tool path caps replays at one (see recover) so a
  // server that processed-then-timed-out isn't re-sent repeatedly.
  if (code === -32001 || (code === 404 && /session not found/i.test(msg))) {
    return "session-lost";
  }
  // transient — exact prior `isTransientTransport` logic, checked second.
  if (
    code === 502 ||
    code === 503 ||
    code === 504 ||
    /bad[ _]gateway|service unavailable|gateway time-?out/i.test(msg)
  ) {
    return "transient";
  }
  if (err instanceof UnauthorizedError) return "auth-lost";
  // Standard JSON-RPC protocol errors the server *answered* with — the transport
  // is fine, restarting won't help.
  if (
    code === -32700 || // parse error
    code === -32600 || // invalid request
    code === -32601 || // method not found
    code === -32602 || // invalid params
    code === -32603 || // internal error
    code === -32002 // resource not found (op-scoped; isMcpResourceMiss owns it per op)
  ) {
    return "none";
  }
  // Recognized torn-transport shapes. (-32000 is the SDK's connection-closed code.)
  if (
    code === -32000 ||
    /connection closed|fetch failed|socket hang ?up|terminated|network error|econnre(set|fused)|timed? ?out|epipe|broken pipe/i.test(
      msg,
    )
  ) {
    return "transport-dead";
  }
  // Couldn't positively classify it — let the caller decide (recover vs surface).
  return "unknown";
}

/**
 * What `McpSource.recover` does with a connection failure. A deliberately small
 * vocabulary — only what the recovery effector actually distinguishes:
 *
 *  - `recover` — re-establish (a fresh `initialize` via stop()+start()) and retry.
 *  - `reauth` — flip to `reauth_required` and surface a Reconnect; never loop
 *    (a dead credential won't heal by restarting).
 *  - `surface` — return the error to the caller; recovery can't help.
 *
 * (The richer vocabulary in the SPEC — separate reinit/restart actions,
 * re-register, credential-lost — lands with its consumers in later phases; at
 * this layer reinit and restart are the same stop()+start(), so they're one.)
 */
export type RecoveryAction = "recover" | "reauth" | "surface";

/**
 * Pure policy: `(connection-failure, context) → action`. The single decision
 * point for recovery. `idempotent` is false for task-augmented `tools/call`
 * (retrying would duplicate spawned server-side state), so every failure on a
 * non-idempotent op surfaces rather than retries. `hasReauthableProvider` is a
 * property of the *source*, not the error: a 401 on an OAuth remote is fixable by
 * reauth; the same 401 on a static-auth remote is an operator-credential problem
 * with nothing to re-run, so it surfaces. See SPEC §3.2.
 */
export function policyFor(
  kind: Exclude<ConnectionFailure, "none" | "unknown">,
  ctx: { idempotent: boolean; hasReauthableProvider: boolean },
): RecoveryAction {
  if (kind === "auth-lost") return ctx.hasReauthableProvider ? "reauth" : "surface";
  // session-lost / transient / transport-dead: re-establishable iff the op is safe to repeat.
  return ctx.idempotent ? "recover" : "surface";
}

/**
 * Delays (ms) before each remote-session re-establish attempt. The first is
 * immediate — the common case is a stale session against an already-healthy
 * server, recovered in one fresh `initialize`. The rest ride a rolling deploy's
 * brief gateway window (~2.5s total); HealthMonitor's longer exponential backoff
 * is the backstop for anything beyond it.
 */
const SESSION_RECOVERY_DELAYS_MS = [0, 500, 2000] as const;

/**
 * Backoff for a tool-call (`execute`) recovery: a SINGLE immediate re-establish +
 * retry. A `tools/call` can be a mutation (and `idempotent: !isTaskAugmented`
 * only means "didn't spawn a server-side task", not "safe to replay"), so it
 * keeps the historical one-retry budget — never the multi-attempt window reads
 * use — to bound duplicate-side-effect exposure when a call times out or the
 * transport drops after the server may already have processed it.
 */
const TOOL_CALL_RECOVERY_DELAYS = [0] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
