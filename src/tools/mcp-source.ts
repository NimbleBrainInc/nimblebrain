import type {
  CallToolResult,
  ClientCapabilities,
  ClientOptions,
  CreateTaskResult,
  Implementation,
  Request as JsonRpcRequest,
  McpSubscription,
  PriorDiscovery,
  RequestMethod,
  RequestOptions,
  ResultTypeMap,
  ServerCapabilities,
  StandardSchemaV1,
  Task,
  Transport,
} from "@modelcontextprotocol/client";
import {
  Client,
  ProtocolError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/core";
import type { Server } from "@modelcontextprotocol/server";
import type { PlacementDeclaration, RemoteTransportConfig } from "../connectors/runtime/types.ts";
import { textContent } from "../engine/content-helpers.ts";
import {
  type ContentBlock,
  type EventSink,
  INFRA_ERROR_META_KEY,
  NON_ADVANCING_META_KEY,
  SKILL_ACTIVATED_META_KEY,
  SKILL_SUPPRESSION_META_KEY,
  type ToolResult,
} from "../engine/types.ts";
import {
  HOST_RESOURCES_LIST_METHOD,
  HOST_RESOURCES_READ_METHOD,
  type HostResourcesRateLimit,
  type HostResourcesResolver,
  hostExtensions,
} from "../host-resources/index.ts";
import { requestIdentityAttrs, withSpan } from "../observability/index.ts";
import { log } from "../observability/log.ts";
import {
  SKILLS_EXTENSION_ID,
  SKILLS_LIST_METHOD,
  SkillsListResultSchema,
  skillsClientExtension,
} from "../skills/skills-extension.ts";
import { coerceInputForSchema } from "./coerce-input.ts";
import {
  TASKS_EXTENSION_ID,
  type TaskClient,
  type TaskStreamMessage,
  TaskWire,
  TaskWireError,
  taskClientFor,
} from "./mcp-task-client.ts";
import { promoteHiddenErrors } from "./promote-hidden-errors.ts";
import { createRemoteTransport } from "./remote-transport.ts";
import { scrubArgsForDispatch } from "./scrub-args.ts";
import {
  RELAYED_SERVER_NOTIFICATIONS,
  relayableParams,
  type ServerNotification,
} from "./server-notifications.ts";
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
 * Override globally via `McpSource` constructor or per-connector in the future.
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

/** First retry delay after a failed `subscriptions/listen`; doubles per failure. */
const LISTEN_RETRY_BASE_MS = 1_000;
/** Ceiling on the listen retry delay. */
const LISTEN_RETRY_MAX_MS = 60_000;

/**
 * Per-connector context threaded into McpSource so its Client can answer
 * inbound `ai.nimblebrain/resources/*` requests. Owned by the caller
 * (lifecycle, workspace-ops) which knows the workspace; passed into the
 * constructor at spawn time. Absent for in-process platform sources —
 * they are the platform talking to itself and have no business asking
 * the host for resources.
 */
export interface ConnectorMcpContext {
  workspaceId: string;
  /** The McpSource name (connector slug). Used for audit + rate-limit attribution. */
  connectorId: string;
  hostResources: HostResourcesResolver;
  rateLimit: HostResourcesRateLimit;
}

/**
 * Inbound params schemas for the two namespaced host-resource methods, taken
 * from the spec `resources/{read,list}` requests' own `params` so the shape
 * (uri / cursor / `_meta`) stays spec-blessed rather than restated here.
 * Params rather than whole requests because these are custom methods: the
 * SDK's three-argument registration validates the params and hands the
 * handler the parsed params. Layer 3 migration is just `s/ai.nimblebrain\///`.
 */
const NbReadResourceParamsSchema = ReadResourceRequestSchema.shape.params;
const NbListResourcesParamsSchema = ListResourcesRequestSchema.shape.params;

/** How this runtime names itself to every server it connects to. */
const CLIENT_INFO: Implementation = { name: "nimblebrain", version: "0.1.0" };

export type { ResourceData } from "./types.ts";

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
 * Terminal-shape + policy inputs for `recover`. The connection-failure
 * classification is op-independent and shared; the op-specific terminal
 * representations (a `ToolResult` for `execute`, a `ResourceData | null` for
 * `readResource`) come from `surface` / `reauth` / `miss`.
 */
interface RecoveryShape<T> {
  idempotent: boolean;
  /** How to treat an `unknown` (unclassifiable) throw. Tool calls set this so
   *  an unrecognized transport error still recovers (old "restart on any
   *  throw" robustness); reads leave it false so a malformed result / server
   *  code surfaces instead of restart-storming the whole source. */
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
 * Whether two mapped tool lists differ in a way the LLM or UI would observe —
 * the set of tool names, or any tool's description / input schema / execution
 * metadata. Order-independent (`tools/list` ordering isn't guaranteed stable
 * across server restarts). Used to gate the `toolsChanged` fan-out so a
 * refresh that returns the identical surface doesn't needlessly invalidate
 * memoized tool unions downstream.
 */
export function toolListChanged(a: readonly Tool[], b: readonly Tool[]): boolean {
  if (a.length !== b.length) return true;
  const signature = (tools: readonly Tool[]) =>
    tools
      .map((t) => JSON.stringify([t.name, t.description, t.inputSchema, t.execution ?? null]))
      .sort()
      .join("\u0000");
  return signature(a) !== signature(b);
}

/**
 * A `Client` whose 2025 `initialize` handshake claims extensions beyond the
 * capabilities it was constructed with.
 *
 * SDK v2 fixes a client's capabilities at construction and sends that one
 * value everywhere: in `initialize` on a 2025-era connection, and in the
 * per-request `_meta` envelope on a 2026-07-28 one, the `server/discover`
 * probe included. The era is known only after the probe, and capabilities
 * cannot change once the transport is attached, so an era-specific claim goes
 * on the one request only the 2025 era sends. `initialize` is sent through
 * `request()` from the SDK's single handshake path, which this override
 * extends by adding the extensions to the capabilities the SDK put there;
 * every other request passes through untouched.
 */
class EraCapabilitiesClient extends Client {
  constructor(
    clientInfo: Implementation,
    options: ClientOptions,
    private readonly initializeExtensions: NonNullable<ClientCapabilities["extensions"]>,
  ) {
    super(clientInfo, options);
  }

  override request<M extends RequestMethod>(
    request: { method: M; params?: Record<string, unknown> },
    options?: RequestOptions,
  ): Promise<ResultTypeMap[M]>;
  override request<T extends StandardSchemaV1>(
    request: JsonRpcRequest,
    resultSchema: T,
    options?: RequestOptions,
  ): Promise<StandardSchemaV1.InferOutput<T>>;
  override request(request: JsonRpcRequest, ...rest: [unknown?, unknown?]): Promise<unknown> {
    let sent = request;
    if (request.method === "initialize") {
      const claimed = (request.params?.capabilities ?? {}) as ClientCapabilities;
      const capabilities: ClientCapabilities = {
        ...claimed,
        extensions: { ...claimed.extensions, ...this.initializeExtensions },
      };
      sent = { ...request, params: { ...request.params, capabilities } };
    }
    // The implementation signature is wider than either SDK overload, so the
    // super call goes through the overload-erased shape both funnel into.
    const send = super.request as (r: JsonRpcRequest, ...a: unknown[]) => Promise<unknown>;
    return send.call(this, sent, ...rest);
  }
}

/**
 * ToolSource wrapping a single MCP server (remote HTTP/SSE, or in-process).
 * Lazy tool loading: first tools() call triggers listTools(), then caches.
 * Crash recovery: on execute failure, attempts one restart + retry.
 */
export class McpSource implements ToolSource {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private cachedTools: Tool[] | null = null;
  /**
   * When `cachedTools` was last populated from a live `tools/list`. Null
   * whenever the memo is empty (never fetched, or dropped by stop/restart/
   * native list_changed). Read by {@link toolsWithMaxAge} to decide whether a
   * remote source's memo is stale enough to re-fetch — a remote server
   * redeployed at the same URL changes its tool surface with no lifecycle
   * signal to this client, so the memo would otherwise stay pinned to
   * first-connect forever.
   */
  private toolsFetchedAt: number | null = null;
  /**
   * A `tools/list` round-trip in progress, shared so concurrent readers reuse
   * one request instead of each firing its own. A remote roll can land several
   * connector-page reads here at once (the read path is not serialized the way
   * tool dispatch is); without this each would issue a duplicate `tools/list`.
   */
  private toolsFetchInFlight: Promise<Tool[]> | null = null;
  /** A {@link refreshTools} in progress, shared so concurrent refreshes reuse
   *  one round-trip AND emit the change signal at most once. */
  private refreshInFlight: Promise<Tool[]> | null = null;
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
  /** Timestamp of the last FAILED on-demand reconnect ({@link reconnectOnDemand}),
   *  or null when there is no unpaid failure — reset by any successful `start()`
   *  (so a heal via HealthMonitor / recover() clears it too, not just
   *  reconnectOnDemand's own retry). Floors how often the app-surface execute/read
   *  paths stop()/start()-cycle a torn-down source, so a persistently-unreachable
   *  upstream isn't hammered at the UI's poll cadence and HealthMonitor's slower
   *  re-probe schedule stays the backstop. The floor gates only CONSECUTIVE failures
   *  with no successful connect between them; a healthy idle-close heals on the
   *  first call. */
  private lastReconnectFailedAt: number | null = null;
  private startedAt: number | null = null;
  /** Optional `instructions` string returned by the MCP server during
   *  `initialize`. Captured after connect so callers (e.g. the system
   *  prompt composer) can surface per-connector guidance to the LLM. */
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
   * Listeners notified when the server pushes
   * `notifications/resources/updated` for a resource this source subscribed
   * to. The notifications poller registers one and treats it as "read this
   * outbox now" — a latency hint, never the delivery: the poll runs on its own
   * cadence whether or not one ever arrives.
   */
  private readonly resourceUpdatedListeners = new Set<(uri: string) => void>();

  /**
   * Listeners for the server's own notifications that a host relays to the
   * server's views (`RELAYED_SERVER_NOTIFICATIONS`). `ToolRegistry` subscribes
   * one per registry the source belongs to. See
   * {@link ToolSource.subscribeServerNotifications}.
   */
  private readonly serverNotificationListeners = new Set<
    (notification: ServerNotification) => void
  >();

  /**
   * Resource URIs this source has asked the server to push updates for.
   *
   * Kept because a subscription belongs to a *connection*: an idle-close or a
   * HealthMonitor restart builds a new Client, and the server has no record of
   * the old one's subscribe. Re-issued after every successful connect, which is
   * also why the set survives `stop()` — the next `start()` is what re-arms it.
   */
  private readonly subscribedResourceUris = new Set<string>();

  /**
   * The task operations on the current connection (see `mcp-task-client.ts`).
   * Built after every successful connect, dropped on `stop()`: its wire wraps
   * the connection's transport, so it is as single-use as the transport is.
   */
  private taskClient: TaskClient | null = null;

  /**
   * The era the current connection negotiated, recorded once at connect
   * (`onConnected`). An era is a property of a connection, so it is read here
   * rather than re-derived per call, and reset with the connection.
   */
  private protocolEra: "legacy" | "modern" = "legacy";

  /**
   * The `subscriptions/listen` stream a 2026-07-28 connection receives change
   * notifications on. That era sends none unsolicited, so without it
   * `tools/list_changed`, `resources/updated` and the relayed notifications
   * would go quiet. `null` on a legacy connection, which is pushed them.
   */
  private subscription: McpSubscription | null = null;
  /** The tail of the serialized `listen()` calls (see `listen`). */
  private listenQueue: Promise<void> = Promise.resolve();
  /** Consecutive failed listens on the current client, for the retry backoff. */
  private listenFailures = 0;

  /**
   * `eventSink` is REQUIRED, not optional. Emitted events include
   * `tool.progress` during task-augmented calls and `run.error` when the
   * source crashes.
   *
   * Pass `new NoopEventSink()` only when a caller deliberately wants to
   * discard events (e.g. short-lived sources that aren't part of an agent
   * session). "I didn't think about it" is not one of those cases.
   *
   * `connectorContext` is optional and threaded only on connector-spawning
   * paths. When set, the Client registers inbound handlers for
   * `ai.nimblebrain/resources/{read,list}` against the connector's
   * workspace. In-process platform sources don't pass it (they're MCP
   * servers talking to the platform itself, not connectors requesting
   * platform resources).
   */
  constructor(
    readonly name: string,
    private mode: McpTransportMode,
    private eventSink: EventSink,
    private readonly connectorContext?: ConnectorMcpContext,
    /**
     * The name this source appears under ON THE WIRE, when it differs from
     * `name`. Set for a personal connector, whose wire form carries the reserved
     * marker while its registry key stays bare.
     *
     * Only events use it. `name` remains the lookup key everywhere else
     * (`registry.getSource`, placements, tool-policy records), so marking it
     * directly would break dispatch.
     */
    private readonly wireName?: string,
  ) {
    log.debug("mcp", `McpSource('${name}') constructed`);
  }

  /**
   * The source name to put on an emitted event.
   *
   * Consumers of `tool.progress` / `run.error` read this as a wire name. A
   * personal connector emitting its bare name there is indistinguishable from a
   * workspace source installed under the same name, which is the exact
   * ambiguity the marker exists to remove.
   */
  private get eventSourceName(): string {
    return this.wireName ?? this.name;
  }

  /** Whether this source connects to a remote MCP server (HTTP/SSE). */
  isRemote(): boolean {
    return this.mode.type === "remote";
  }

  async start(): Promise<void> {
    // Clear deliberate-teardown flags so a restart re-enables crash detection
    // on the new transport. Set in `stop()` to suppress onclose-emitted
    // `source.crashed` events during graceful teardown.
    this.stopping = false;
    this.stopped = false;

    await this.initTransport();
    this.client = this.prepareClient();

    // Timeout MCP handshake — remote gets shorter timeout (15s vs 30s)
    const CONNECT_TIMEOUT = this.mode.type === "remote" ? 15_000 : 30_000;

    try {
      await this.connectOrFallBackToLegacy(CONNECT_TIMEOUT);
    } catch (err) {
      // One-shot OAuth retry: if we have an authProvider and the SDK threw
      // UnauthorizedError, drive the provider's pending flow, finish auth on the
      // existing transport, then rebuild the transport+client and retry connect
      // exactly once. `retryConnectWithOAuth` throws on failure.
      if (this.canRetryWithOAuth(err)) {
        await this.retryConnectWithOAuth(CONNECT_TIMEOUT);
        return;
      }
      await this.cleanupOnStartFailure();
      throw err;
    }

    this.dead = false;
    // Any successful (re)connect clears the on-demand reconnect floor — including a
    // heal via HealthMonitor or recover(), not just reconnectOnDemand's own retry.
    // So the floor gates only CONSECUTIVE failed reconnects with no connect between,
    // and a fresh idle-close right after an out-of-band heal is never wrongly gated.
    this.lastReconnectFailedAt = null;
    this.startedAt = Date.now();

    // Now that start has succeeded, wire transport close-detection.
    // Closes from this point on indicate a real mid-session disconnect
    // (server crashed, network drop, idle timeout) and should mark the
    // source dead so HealthMonitor can take over.
    if (this.transport && this.mode.type === "remote") {
      this.transport.onclose = () => this.emitSourceCrashed("Remote transport closed");
    }
    this.onConnected();
    // Re-arm resource subscriptions on the new connection, once its era is
    // known. Fire-and-forget: a hint that fails to re-establish costs latency,
    // never correctness.
    this.resubscribeResources();

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

  /**
   * Construct `this.transport` (and, for in-process, `this.inProcessServer`)
   * for the current `mode`. Wires the crash-detection `onclose` handler for
   * in-process immediately; remote's is wired in `start()` AFTER a successful
   * connect (see the remote branch note) so a close during the handshake
   * isn't misclassified as a mid-session crash.
   */
  private async initTransport(): Promise<void> {
    if (this.mode.type === "remote") {
      this.transport = await createRemoteTransport(
        this.mode.url,
        this.mode.transportConfig,
        this.mode.authProvider,
        {
          workspaceId: this.connectorContext?.workspaceId,
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
  }

  /**
   * Whether a failed connect can be retried through the headless OAuth flow:
   * a remote source with an attached provider and a live transport that threw
   * `UnauthorizedError`.
   */
  private canRetryWithOAuth(err: unknown): boolean {
    return (
      err instanceof UnauthorizedError &&
      this.mode.type === "remote" &&
      this.mode.authProvider != null &&
      this.transport != null
    );
  }

  /**
   * One-shot OAuth retry after a `UnauthorizedError` on connect. The provider's
   * pending flow was either resolved in-process (headless, e.g. Reboot
   * Anonymous) or rejected with a clear error (interactive, unsupported). Await
   * the flow, finish auth on the EXISTING transport (so tokens land via
   * `authProvider.saveTokens`), then tear down and rebuild the transport+client
   * for the retry — `StreamableHTTPClientTransport` rejects a second `start()`
   * on the same instance (matching the SDK's `simpleOAuthClient` example pattern
   * of new-transport-per-attempt). Resolves on success; rejects on failure after
   * cleaning up. Preconditions are `canRetryWithOAuth`.
   */
  private async retryConnectWithOAuth(timeoutMs: number): Promise<void> {
    if (this.mode.type !== "remote" || !this.mode.authProvider || !this.transport) {
      throw new Error("[mcp-source] retryConnectWithOAuth called without OAuth preconditions");
    }
    const authProvider = this.mode.authProvider;
    const transport = this.transport;
    try {
      const code = await authProvider.awaitPendingFlow();
      const authable = transport as AuthFinishableTransport;
      if (typeof authable.finishAuth !== "function") {
        throw new Error(
          `[mcp-source] transport does not support finishAuth (got ${transport.constructor.name})`,
        );
      }
      await authable.finishAuth(code);
      log.debug("mcp", `[oauth] ${this.name}: finishAuth ok, recreating transport for retry`);

      // Drop the first-attempt transport+client. Both are single-use after a
      // failed start; the SDK tracks internal state (AbortController on the
      // transport, handshake promise on the client) that a second connect would
      // trip over.
      //
      // Clear the onclose handler before close — the existing handler marks the
      // source dead and emits source.crashed, which would race with the retry
      // path: the upcoming HealthMonitor sweep would see `dead === true` and try
      // to restart, fighting our own retry. Re-attached on the new transport in
      // `rebuildRemoteTransport`.
      transport.onclose = undefined;
      await this.cleanupOnStartFailure();
      await this.rebuildRemoteTransport();
      // Handler tables don't carry over from the prior Client instance.
      this.client = this.prepareClient();
      // Re-arm crash detection for the retry: cleanupOnStartFailure set
      // `stopping = true` to suppress its own teardown noise; we need it false
      // again before the new transport's onclose can fire usefully. If this
      // retry connect also fails, the catch below re-suppresses.
      this.stopping = false;

      await this.connectOrFallBackToLegacy(timeoutMs);
      this.onConnected();
      this.startedAt = Date.now();
      // This is a SECOND success seam (the headless OAuth auto-resolve retry).
      // The source is now enumerable, so it must emit the same tools-changed
      // signal as the bottom seam — otherwise a union memoized while a remote
      // OAuth source was unreachable (e.g. `tryRestart` re-auth, or a union
      // cached between addSource and connect-completion on a post-boot
      // startAuth) stays stale: the exact bug this signal exists to kill, on
      // the one branch that skipped it. FOLLOW-UP: this branch also skips
      // `dead = false`, the onclose rewiring, instructions capture, and
      // `startTaskSweeper()` from the bottom seam — a pre-existing asymmetry
      // (tracked separately). The right long-term shape is to converge this
      // path onto the bottom seam instead of early-returning.
      this.emitToolsChanged();
      this.resubscribeResources();
    } catch (retryErr) {
      await this.cleanupOnStartFailure();
      throw retryErr;
    }
  }

  /**
   * Connect, and if the `server/discover` probe met an HTTP 500, connect once
   * more on the 2025 era. The SDK reads a 5xx as a server failure rather than
   * era evidence, but a 2025-era server that answers any method it does not
   * know with a 500 connected before this runtime probed, and must still
   * connect (see `isEraProbeServerFailure` for why a gateway 5xx does not).
   * Both connect seams (`start()` and the OAuth retry) go through here, so the
   * fallback holds on either.
   *
   * The retry rebuilds the transport and client and passes a `legacy` prior,
   * so the SDK skips the probe and runs the 2025 `initialize` handshake. A
   * failure is thrown with the rebuilt transport still live, so the caller's
   * own handling applies to it: `start()` can still take an `UnauthorizedError`
   * from the handshake into the OAuth retry.
   */
  private async connectOrFallBackToLegacy(timeoutMs: number): Promise<void> {
    try {
      await this.connectWithTimeout(timeoutMs);
      return;
    } catch (err) {
      if (!isEraProbeServerFailure(err)) throw err;
      log.warn(
        `[mcp] ${this.name}: server/discover probe failed (${
          err instanceof Error ? err.message : String(err)
        }); connecting on the 2025 era`,
      );
    }
    if (this.transport) this.transport.onclose = undefined;
    await this.cleanupOnStartFailure();
    this.stopping = false;
    await this.initTransport();
    this.client = this.prepareClient();
    await this.connectWithTimeout(timeoutMs, { kind: "legacy" });
  }

  /**
   * A fresh client with every handler registered, before it connects, so none
   * of them misses a request or notification the server sends the instant it
   * answers the handshake. Called on every connect path, because handler tables
   * do not carry across SDK Client instances.
   */
  private prepareClient(): Client {
    const client = this.buildClient();
    // Inbound host-resources handlers. No-op for in-process sources that don't
    // pass a connectorContext.
    this.registerConnectorHandlers(client);
    this.registerToolsChangedHandler(client);
    this.registerResourceUpdatedHandler(client);
    this.registerServerNotificationHandlers(client);
    return client;
  }

  private async connectWithTimeout(timeoutMs: number, prior?: PriorDiscovery): Promise<void> {
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
      await Promise.race([
        this.client.connect(this.transport, prior ? { prior } : undefined),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * What every successful connect does once the era is known, on both success
   * seams (the bottom of `start()` and the OAuth retry): attach the task wire,
   * log the negotiated era, and on a 2026-07-28 connection open the listen
   * stream its change notifications ride.
   */
  private onConnected(): void {
    const client = this.client;
    const transport = this.transport;
    if (!client || !transport) return;
    this.protocolEra = client.getProtocolEra() === "modern" ? "modern" : "legacy";
    this.taskClient = taskClientFor(
      TaskWire.attach(client, transport, CLIENT_INFO, McpSource.CAPABILITIES),
    );
    this.logNegotiatedEra(client);
    if (this.protocolEra === "modern") void this.listen();
  }

  /**
   * One line per connect naming the protocol version this connection landed
   * on, so an operator can see which era each connector speaks.
   */
  private logNegotiatedEra(client: Client): void {
    const line =
      `[mcp] connected source=${this.name} era=${this.protocolEra}` +
      ` protocolVersion=${client.getNegotiatedProtocolVersion() ?? "unknown"}`;
    // A platform app is the runtime talking to itself, always on the 2025
    // in-memory transport; only a remote connection's era is news.
    if (this.mode.type === "remote") log.info(line);
    else log.debug("mcp", line);
  }

  /**
   * (Re)open the `subscriptions/listen` stream with the filter this source
   * needs now: the list-changed kinds the server advertises and every resource
   * URI it has been asked to watch.
   *
   * One owner for the stream. Calls run one at a time, each reading the filter
   * when its turn comes, so the stream acknowledged last is the widest asked
   * for. A replaced stream is closed after its successor is acknowledged, so no
   * window goes unwatched. Any close this source did not ask for (the server
   * ending it, or the connection dropping it) re-listens, and a failed listen,
   * or a stream that ends as soon as it opens, retries with backoff, both for
   * as long as this client is the source's current one. A failure costs change notifications and nothing else, so it
   * is logged, not thrown.
   */
  private listen(): Promise<void> {
    const turn = this.listenQueue.then(() => this.openListenStream());
    this.listenQueue = turn.catch(() => {});
    return turn;
  }

  private async openListenStream(): Promise<void> {
    const client = this.client;
    if (!client || this.protocolEra !== "modern") return;
    const caps = client.getServerCapabilities();
    const filter = {
      ...(caps?.tools?.listChanged ? { toolsListChanged: true } : {}),
      ...(caps?.resources?.listChanged ? { resourcesListChanged: true } : {}),
      ...(caps?.resources?.subscribe && this.subscribedResourceUris.size > 0
        ? { resourceSubscriptions: [...this.subscribedResourceUris] }
        : {}),
    };
    if (Object.keys(filter).length === 0) return;
    let next: McpSubscription;
    try {
      next = await client.listen(filter);
    } catch (err) {
      this.retryListenLater(client, err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.client !== client) {
      void next.close().catch(() => {});
      return;
    }
    const previous = this.subscription;
    this.subscription = next;
    if (previous) void previous.close().catch(() => {});
    const openedAt = Date.now();
    void next.closed.then((why) => {
      if (this.client !== client) return;
      // A stream counts as a successful listen once it has stayed open a
      // while, so a peer that acknowledges and hangs up at once is retried
      // with backoff rather than re-listened in a tight loop.
      const held = Date.now() - openedAt >= LISTEN_RETRY_BASE_MS;
      if (held) this.listenFailures = 0;
      if (why === "local" || this.subscription !== next) return;
      this.subscription = null;
      if (held) void this.listen();
      else this.retryListenLater(client, "the stream ended as soon as it opened");
    });
  }

  /** Count a failed listen and listen again after the backoff, while `client` is current. */
  private retryListenLater(client: Client, reason: string): void {
    this.listenFailures++;
    const delayMs = Math.min(
      LISTEN_RETRY_BASE_MS * 2 ** (this.listenFailures - 1),
      LISTEN_RETRY_MAX_MS,
    );
    log.debug(
      "mcp",
      `[${this.name}] subscriptions/listen failed, retrying in ${delayMs}ms — ${reason}`,
    );
    const timer = setTimeout(() => {
      if (this.client === client) void this.listen();
    }, delayMs);
    timer.unref?.();
  }

  /** The protocol version this connection negotiated, or `undefined` before connect and after `stop()`. */
  getNegotiatedProtocolVersion(): string | undefined {
    return this.client?.getNegotiatedProtocolVersion();
  }

  /**
   * The extensions the server advertised, keyed by extension identifier: from
   * `server/discover` on a 2026-07-28 connection, from the `initialize` result
   * on a 2025-era one. Empty before connect, after `stop()`, and for a server
   * that advertises none. The facets and skills readers take their extension
   * settings from here rather than reaching into the SDK's capability shape.
   */
  serverExtensions(): Record<string, object> {
    return this.client?.getServerCapabilities()?.extensions ?? {};
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
    this.taskClient = null;
    this.subscription = null;
    this.listenFailures = 0;
    this.protocolEra = "legacy";
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
   *     connection loss (the call throws because the connection broke;
   *     the close also fires onclose). Without this guard, listeners
   *     would see two `source.crashed` events for one death, which any
   *     deduplicating consumer (UI, telemetry) gets wrong. Whichever
   *     path runs first wins; its payload is canonical.
   */
  private emitSourceCrashed(error: string): void {
    if (this.stopping || this.dead) return;
    this.dead = true;
    this.eventSink.emit({
      type: "run.error",
      data: {
        source: this.eventSourceName,
        event: "source.crashed",
        error,
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
  private async rebuildRemoteTransport(): Promise<void> {
    if (this.mode.type !== "remote") {
      throw new Error("[mcp-source] rebuildRemoteTransport called on non-remote mode");
    }
    this.transport = await createRemoteTransport(
      this.mode.url,
      this.mode.transportConfig,
      this.mode.authProvider,
      {
        workspaceId: this.connectorContext?.workspaceId,
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
   * The capabilities this client claims on every era. One value, read by
   * `buildClient` and by the task wire's per-request envelope, so a connection
   * and its task calls cannot claim different things. On a 2026-07-28
   * connection the SDK attaches it to every request's `_meta` envelope, the
   * `server/discover` probe included.
   *
   * `tasks` is the 2025-11-25 task capability: a legacy-era server with
   * `execution.taskSupport` on a tool sees that we will attach
   * `params.task: {ttl}` rather than block the request, and that we can cancel
   * what we started. `tasks.list` is not claimed: nothing here calls it. The
   * 2026-07-28 tasks extension (`io.modelcontextprotocol/tasks`) is NOT
   * claimed here, because a claim on the connection would opt every SDK call
   * in, and the SDK cannot read a task result; the task wire claims it per
   * request instead (`mcp-task-client.ts`).
   *
   * `io.modelcontextprotocol/skills` (SEP-2640) is claimed on both eras
   * because skill discovery runs on both: {@link listSkills} enumerates, and
   * the runtime verifies each `SKILL.md` it later reads against the listing.
   */
  private static readonly CAPABILITIES: ClientCapabilities = {
    tasks: {
      requests: { tools: { call: {} } },
      cancel: {},
    },
    extensions: skillsClientExtension(),
  };

  /**
   * What the 2025 `initialize` handshake claims on top of `CAPABILITIES`: the
   * NimbleBrain-namespaced extensions (`ai.nimblebrain/host-resources`, per
   * https://modelcontextprotocol.io/extensions/overview). The host-resources
   * methods are server→client requests, a channel only the 2025 era has, so
   * the extension is claimed only on the handshake of a connection that can
   * reach them, and only by a source that serves them: one with a
   * `connectorContext`, which is what registers the handlers
   * ({@link registerConnectorHandlers}). A source without one (an in-process
   * platform source, or a remote connector started on a path that does not
   * thread the host-resources deps) claims nothing it would not answer
   * (ADR-0023).
   */
  private static readonly INITIALIZE_EXTENSIONS: NonNullable<ClientCapabilities["extensions"]> =
    hostExtensions();

  /**
   * The client this source connects with. One builder, called on the initial
   * start and again on the OAuth retry rebuild.
   *
   * `versionNegotiation: auto` probes `server/discover` and falls back to the
   * 2025 `initialize` handshake against a server that does not answer it, so
   * each connection lands on the best era both ends speak; the verdict is
   * logged per connect (`logNegotiatedEra`). Never pinned: the fleet and
   * remote connectors move eras on their own schedules.
   */
  private buildClient(): Client {
    return new EraCapabilitiesClient(
      CLIENT_INFO,
      { capabilities: McpSource.CAPABILITIES, versionNegotiation: { mode: "auto" } },
      this.connectorContext ? McpSource.INITIALIZE_EXTENSIONS : {},
    );
  }

  /**
   * Register inbound handlers for the host-resources extension methods.
   * Called once per Client lifecycle — after `new Client()` (initial
   * start) and after `buildClient()` (OAuth retry rebuild). No-op when
   * `connectorContext` is absent (in-process platform sources don't need
   * the surface).
   *
   * These are server→client requests, a channel only the 2025 era has: on a
   * 2026-07-28 connection the SDK drops inbound requests. The capability is
   * claimed in the 2025 `initialize` only (`INITIALIZE_EXTENSIONS`), so a
   * connector sees it exactly where it can call these methods.
   *
   * Handlers do three things, in order: rate-limit check (throws
   * `-32004` on exhaustion), delegate to the resolver (which enforces
   * scheme allowlist + workspace isolation + size cap), and log via
   * the `host-resources` debug namespace. Errors propagate as JSON-RPC
   * errors back to the connector.
   */
  private registerConnectorHandlers(client: Client): void {
    const ctx = this.connectorContext;
    if (!ctx) return;

    client.setRequestHandler(
      HOST_RESOURCES_READ_METHOD,
      { params: NbReadResourceParamsSchema },
      async (params) => {
        ctx.rateLimit.check(ctx.workspaceId, ctx.connectorId);
        return ctx.hostResources.read(params.uri, {
          workspaceId: ctx.workspaceId,
          connectorId: ctx.connectorId,
        });
      },
    );

    client.setRequestHandler(
      HOST_RESOURCES_LIST_METHOD,
      { params: NbListResourcesParamsSchema },
      async (parsed) => {
        ctx.rateLimit.check(ctx.workspaceId, ctx.connectorId);
        const params = parsed ?? {};
        return ctx.hostResources.list(
          // Connector-supplied filter rides in `_meta` per MCP convention for
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
          { workspaceId: ctx.workspaceId, connectorId: ctx.connectorId },
        );
      },
    );
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
   * don't carry across SDK Client instances. Unlike `registerConnectorHandlers`
   * this runs for every source (in-process platform sources included): any
   * MCP server may push the notification.
   */
  private registerToolsChangedHandler(client: Client): void {
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      this.cachedTools = null;
      this.toolsFetchedAt = null;
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

  /**
   * Register the client-side handler for `notifications/resources/updated`.
   *
   * Called once per Client lifecycle, beside {@link registerToolsChangedHandler}
   * and for the same reason: handler tables do not carry across SDK Client
   * instances, so a source that reconnected would go quiet with nothing to say
   * it had.
   *
   * The handler fans the URI out and does nothing else. What an update *means*
   * belongs to whoever subscribed — for the notifications poller it means "read
   * this outbox now", and a handler that decided that here would bind this
   * transport-level seam to one consumer.
   */
  private registerResourceUpdatedHandler(client: Client): void {
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      const uri = notification.params?.uri;
      if (typeof uri === "string") this.emitResourceUpdated(uri);
    });
  }

  /**
   * Ask the server to push `notifications/resources/updated` for one URI, and
   * report whether it will.
   *
   * Returns `false` — without sending anything — when the server did not
   * advertise `resources.subscribe` in its `initialize` result. Declared
   * capabilities are authoritative per spec, so probing past them would mean
   * every tools-only server pays a round trip to be told `Method not found`,
   * once per source per connect.
   *
   * Idempotent per URI in the sense that matters: the URI is remembered and
   * re-subscribed after every reconnect, so a caller subscribes once and the
   * source keeps the promise across restarts.
   *
   * On a 2026-07-28 connection there is no `resources/subscribe`: the URI joins
   * the `resourceSubscriptions` of the listen stream, which is reopened with it.
   */
  async subscribeResourceUpdates(uri: string): Promise<boolean> {
    if (this.getServerCapabilities()?.resources?.subscribe !== true) return false;
    const client = this.client;
    if (!client) return false;
    if (this.protocolEra === "modern") {
      if (!this.subscribedResourceUris.has(uri)) {
        this.subscribedResourceUris.add(uri);
        await this.listen();
      }
      return this.subscription !== null;
    }
    try {
      await client.subscribeResource({ uri });
    } catch (err) {
      log.debug(
        "mcp",
        `[${this.name}] resources/subscribe(${uri}) failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
    this.subscribedResourceUris.add(uri);
    return true;
  }

  /**
   * Listen for `notifications/resources/updated`. Returns an unsubscribe
   * function. The listener receives every subscribed URI this source is pushed,
   * so a caller watching one resource filters on it.
   */
  subscribeResourceUpdated(listener: (uri: string) => void): () => void {
    this.resourceUpdatedListeners.add(listener);
    return () => {
      this.resourceUpdatedListeners.delete(listener);
    };
  }

  /**
   * Re-issue every tracked `resources/subscribe` on a freshly connected client.
   *
   * Fire-and-forget by design: a subscription is a latency hint, so failing to
   * re-establish one costs a slower first read and nothing else. Blocking a
   * connect on it would let a server's subscribe handler decide whether the
   * source comes up.
   */
  private resubscribeResources(): void {
    // A modern connection re-arms every URI in the listen stream `onConnected` opens.
    if (this.subscribedResourceUris.size === 0 || this.protocolEra === "modern") return;
    for (const uri of this.subscribedResourceUris) {
      void this.subscribeResourceUpdates(uri);
    }
  }

  /** Fan out a resource-updated signal to subscribers, isolating failures. */
  private emitResourceUpdated(uri: string): void {
    for (const listener of this.resourceUpdatedListeners) {
      try {
        listener(uri);
      } catch (err) {
        log.debug(
          "mcp",
          `[${this.name}] resourceUpdated listener threw — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Register a client-side handler for every notification on the relay
   * allowlist (`RELAYED_SERVER_NOTIFICATIONS`).
   *
   * Called once per Client lifecycle, beside {@link registerResourceUpdatedHandler}
   * and for the same reason: handler tables do not carry across SDK Client
   * instances.
   *
   * A handler receives what the SDK schema parsed and passes on the method and
   * the params `relayableParams` admits — nothing else from the frame. This
   * source holds nothing derived from any of these listings, so the handler only
   * fans the notification out; what it means belongs to the views that get it.
   */
  private registerServerNotificationHandlers(client: Client): void {
    for (const method of RELAYED_SERVER_NOTIFICATIONS) {
      client.setNotificationHandler(method, (notification) => {
        const params = relayableParams(notification.params);
        this.emitServerNotification({ method, ...(params ? { params } : {}) });
      });
    }
  }

  /**
   * Listen for the server's relayed notifications. Returns an unsubscribe
   * function. See {@link ToolSource.subscribeServerNotifications}.
   */
  subscribeServerNotifications(listener: (notification: ServerNotification) => void): () => void {
    this.serverNotificationListeners.add(listener);
    return () => {
      this.serverNotificationListeners.delete(listener);
    };
  }

  /** Fan a relayed notification out to subscribers, isolating failures. */
  private emitServerNotification(notification: ServerNotification): void {
    for (const listener of this.serverNotificationListeners) {
      try {
        listener(notification);
      } catch (err) {
        log.debug(
          "mcp",
          `[${this.name}] server notification listener threw — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Capabilities the server declared in its `initialize` result, or `undefined`
   * before the handshake completes and after `stop()`.
   *
   * Exposed so a caller can honour the spec's rule that declared capabilities
   * are authoritative without reaching through {@link getClient}, which hands
   * out the whole SDK surface for what is one read.
   */
  getServerCapabilities(): ServerCapabilities | undefined {
    return this.client?.getServerCapabilities();
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

  /**
   * On-demand reconnect for the app-surface paths (`execute`, and the `ui://`
   * `readResource` proxy) when the client was torn down by an idle-close / crash
   * and no HealthMonitor tick has re-established it yet. Returns whether a live
   * client is available afterward.
   *
   * Heals the window between a self-dropped transport and the next HealthMonitor
   * sweep, so a foreground app call self-heals instead of surfacing a raw
   * "not started". Three guards keep it safe:
   *   - a deliberately-stopped source ({@link isStopped}) is terminal — never
   *     revived (its stale provider would clobber the shared on-disk credentials a
   *     fresh flow depends on; HealthMonitor gates on the same predicate);
   *   - it rides the shared {@link restartInFlight} cycle via {@link tryRestart},
   *     so concurrent callers and a HealthMonitor tick coalesce onto one
   *     stop()/start() instead of storming;
   *   - repeated FAILED attempts are floored behind `RECONNECT_COOLDOWN_MS` so a
   *     persistently-down upstream isn't stop()/start()-hammered at the UI poll
   *     cadence (a healthy idle-close still reconnects on the first call).
   */
  private async reconnectOnDemand(): Promise<boolean> {
    if (this.client) return true;
    // isStopped() is checked-then-acted-on (the restart drives stop()/start()), so a
    // deliberate stop() interleaving after this check could be undone by the restart.
    // The window is tiny and self-correcting (the completed stop leaves the next call
    // client===null && stopped, which blocks revival), and HealthMonitor's reconnect
    // path carries the identical check-then-restart shape — so this matches existing
    // behavior rather than introducing a new race.
    if (this.isStopped()) return false;
    const now = Date.now();
    if (
      this.lastReconnectFailedAt !== null &&
      now - this.lastReconnectFailedAt < RECONNECT_COOLDOWN_MS
    ) {
      return false;
    }
    await this.tryRestart(); // coalesced via restartInFlight; never throws
    if (this.client) {
      this.lastReconnectFailedAt = null;
      return true;
    }
    this.lastReconnectFailedAt = now;
    return false;
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
      // Not awaited: the cancel is a request to a server this source is leaving,
      // which may never answer, and closing the transport below ends the stream
      // either way.
      if (this.subscription) void this.subscription.close().catch(() => {});
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
    this.taskClient = null;
    this.subscription = null;
    this.listenFailures = 0;
    this.protocolEra = "legacy";
    this.cachedTools = null;
    this.toolsFetchedAt = null;
    this.toolsFetchInFlight = null;
    this.refreshInFlight = null;
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
   * server end of the linked-pair transport. For `remote` mode the source
   * is a *client* of an external server and has nothing to emit on — call
   * becomes a silent no-op.
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
   * The host DOES consume the inbound direction of this signal — see
   * {@link subscribeResourceUpdates} — but `defineInProcessApp` advertises no
   * `resources.subscribe` capability and registers no `resources/subscribe`
   * handler, so a platform built-in emitting one reaches nobody. A source that
   * wants to be subscribed to builds its own server (the notifications
   * poller's test fixture does) rather than gaining the capability here, where
   * every built-in would claim a promise none of them serves.
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
   * (platform built-ins); `[]` for remote sources, whose placements
   * come from the connector manifest and are tracked separately by the
   * connector lifecycle.
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

  /**
   * Issue a `tools/list` and map the response into the registry's `Tool`
   * shape. Does NOT read or write `cachedTools` — callers decide whether the
   * result seeds the memo ({@link tools}) or replaces it ({@link refreshTools}).
   * Concurrent callers share one round-trip via `toolsFetchInFlight`.
   *
   * Every spec-defined field a listing can carry comes across: `_meta` and
   * `annotations` are separate namespaces and land in the separate fields of
   * the same name, and `outputSchema` rides along. Dropping either annotation
   * namespace here is silent — the server said something about the tool and the
   * host simply never heard it, which is how a tool that declares
   * `destructiveHint` gets treated like a read-only one.
   *
   * A client that has not finished its handshake counts as not started. The
   * client exists before `connect()` resolves (for a remote OAuth source, for
   * the whole of pending auth, while the source is already registered), and the
   * SDK answers `listTools()` on it with an empty list rather than an error, as
   * if the server advertised no tools. Memoized, that empty list would outlive
   * the connect.
   */
  private fetchToolList(): Promise<Tool[]> {
    if (this.toolsFetchInFlight) return this.toolsFetchInFlight;
    if (!this.client?.getServerCapabilities()) {
      throw new Error(`McpSource "${this.name}" not started`);
    }
    const client = this.client;
    const p = (async () => {
      const response = await client.listTools();
      return response.tools.map((t) => {
        const rawExec = (t as { execution?: unknown }).execution;
        const execution = isExecutionMeta(rawExec)
          ? { taskSupport: rawExec.taskSupport }
          : undefined;
        return {
          name: `${this.name}__${t.name}`,
          description: t.description ?? "",
          inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          outputSchema: t.outputSchema as Record<string, unknown> | undefined,
          source: `mcp:${this.name}`,
          meta: t._meta as Record<string, unknown> | undefined,
          annotations: t.annotations,
          execution,
        };
      });
    })();
    this.toolsFetchInFlight = p;
    return p.finally(() => {
      if (this.toolsFetchInFlight === p) this.toolsFetchInFlight = null;
    });
  }

  async tools(): Promise<Tool[]> {
    if (this.cachedTools) return this.cachedTools;
    const fetched = await this.fetchToolList();
    this.cachedTools = fetched;
    this.toolsFetchedAt = Date.now();
    return this.cachedTools;
  }

  /**
   * Force a fresh `tools/list`, replacing the memo in place and re-stamping
   * `toolsFetchedAt`. Unlike {@link tools} this bypasses the memo, so it is the
   * seam for picking up a remote server whose tool surface changed WITHOUT a
   * lifecycle event (redeployed at the same URL, no reconnect, no native
   * `tools/list_changed`). When the resulting surface actually differs from
   * what was cached, fans out via `emitToolsChanged()` so the workspace tool
   * union and the engine's LLM tool list converge in lockstep with the UI; a
   * no-op refresh stays silent to avoid needless union invalidation.
   *
   * Note: does NOT refresh the reported handshake version
   * ({@link getReportedVersion}) — that comes from the `initialize` response,
   * not `tools/list`, so only a reconnect (`restart()`) updates it.
   *
   * The dispatch path ({@link execute} via {@link findTool}) is deliberately
   * NOT routed through here: it stays on the memo so a tool call never pays a
   * `tools/list` round-trip.
   */
  async refreshTools(): Promise<Tool[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const previous = this.cachedTools;
    const p = (async () => {
      const fetched = await this.fetchToolList();
      this.cachedTools = fetched;
      this.toolsFetchedAt = Date.now();
      // previous === null means the memo was empty; the connect seam already
      // emits on first population, so only a real surface change re-fans-out.
      if (previous !== null && toolListChanged(previous, fetched)) {
        this.emitToolsChanged();
      }
      return fetched;
    })();
    this.refreshInFlight = p;
    return p.finally(() => {
      if (this.refreshInFlight === p) this.refreshInFlight = null;
    });
  }

  /**
   * Tools, re-fetching when the memo is older than `maxAgeMs`. For the
   * connector read surfaces (Configure / installed-list), which must reflect a
   * redeployed remote server's current tools rather than the first-connect
   * snapshot. A refresh failure falls back to the last good memo (a transient
   * blip shouldn't blank the tool list); only a cold miss with no memo throws.
   */
  async toolsWithMaxAge(maxAgeMs: number): Promise<Tool[]> {
    const fresh =
      this.cachedTools !== null &&
      this.toolsFetchedAt !== null &&
      Date.now() - this.toolsFetchedAt <= maxAgeMs;
    if (fresh && this.cachedTools) return this.cachedTools;
    try {
      return await this.refreshTools();
    } catch (err) {
      if (this.cachedTools) {
        log.debug(
          "mcp",
          `[${this.name}] tool-list refresh failed, serving cached — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return this.cachedTools;
      }
      throw err;
    }
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

  /**
   * Recover string-encoded structured args against THIS server's own advertised
   * schema, then strip no-op optional values — both keyed off `tool.inputSchema`,
   * the schema this source advertised at `tools/list`.
   *
   * Coerce first: models routinely emit object/array parameters as JSON-encoded
   * strings (`to_recipients: "[\"a@b.com\"]"` instead of the array). The engine
   * runs the same coercion against the schema it built for the LLM, but that view
   * can diverge from this source's live schema (search-promoted tools,
   * cross-workspace dispatch) — and any divergence means a stringified array
   * reaches the wire and the upstream validator rejects it ("Input should be a
   * valid list on parameter to_recipients"). Re-coercing here, at the dispatch
   * boundary, against the source's own schema closes that gap for every call
   * routed through `execute` — the agent loop's inline and task-augmented paths
   * both flow through here. `coerceInputForSchema` is pure and idempotent: an
   * already-correct array survives unchanged, so the redundant engine-side pass
   * is harmless.
   *
   * Scope: this covers the `execute` path only. The external `/mcp` task surface
   * dispatches via `startToolAsTask` directly (see mcp-server.ts), bypassing
   * this; that path is folded into the separate `/mcp` overhaul (#423).
   * Limitation: coercion is a no-op when the array/object param is expressed via
   * `$ref`/`allOf` (see `coerce-input.ts`) — Composio's flat `type: "array"`
   * schemas are covered; richer shapes are tracked in #424.
   *
   * Order matters: coerce before scrub so a stringified empty array (`"[]"`)
   * becomes `[]` and is then eligible for no-op stripping.
   */
  private prepareDispatchArgs(
    tool: Tool | undefined,
    input: Record<string, unknown>,
    toolName: string,
  ): Record<string, unknown> {
    const coerced = tool?.inputSchema ? coerceInputForSchema(input, tool.inputSchema) : input;
    // Strip no-op values models routinely emit for optional fields (empty
    // strings, nil UUIDs, empty arrays). Some upstream APIs treat these as real
    // values and reject with HTTP 400. Equivalent to the model having omitted the
    // field. Required fields pass through unchanged.
    const scrubbed = tool?.inputSchema
      ? scrubArgsForDispatch(coerced, tool.inputSchema)
      : { args: coerced, stripped: [] };
    if (scrubbed.stripped.length > 0) {
      log.debug(
        "mcp",
        `scrub source=${this.name} tool=${toolName} stripped=${scrubbed.stripped.join(",")}`,
      );
    }
    return scrubbed.args;
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    // A live client dispatches — even with `dead` set: a stale crash flag over a
    // working transport, or a torn one, both route their throw through recover()
    // (classify → restart only on a connection-down class, never a timeout/auth-loss
    // — the #581 policy), so short-circuiting on `dead` here would deny that
    // self-heal and surface a spurious "not started". Only a genuinely torn-down
    // (null) client errors, and only after an on-demand reconnect fails — healing
    // the window between an idle-close and the next HealthMonitor tick.
    if (!this.client && !(await this.reconnectOnDemand())) {
      // Deliberately NOT marked infrastructure. This branch is reached only
      // after `reconnectOnDemand()` has already failed, and a failed reconnect
      // is floored behind RECONNECT_COOLDOWN_MS — so every later call returns
      // here instantly and for free. Exempting it from the strike count would
      // remove the run's only brake on a source that is not coming back, and
      // let the model re-issue the same dead call every iteration. Tripping at
      // three is the correct outcome here; the sibling spelling of the same
      // condition (a source absent from the registry, via
      // `mapOrchestratorErrorToToolResult`) is unmarked for the same reason.
      return {
        content: textContent(`McpSource "${this.name}" not started`),
        isError: true,
      };
    }

    // Dispatch on whether the call may come back as a task. On a 2025-era
    // connection that is the tool's own `execution.taskSupport`
    // ("optional" | "required"). On a 2026-07-28 connection the server alone
    // decides per call (SEP-2663) and tool listings carry no task marker, so
    // every call to a server advertising the tasks extension takes the task
    // path, which handles a complete answer as well. Either way the call
    // returns immediately with a task and we poll it to the final `result` or
    // `error`. Everything else uses the inline path.
    const tool = this.findTool(toolName);
    const taskSupport = tool?.execution?.taskSupport;
    const isTaskAugmented =
      this.protocolEra === "modern"
        ? TASKS_EXTENSION_ID in this.serverExtensions()
        : taskSupport === "optional" || taskSupport === "required";

    const dispatchArgs = this.prepareDispatchArgs(tool, input, toolName);

    // Answers: "why is this tool call going inline vs task-augmented?" and
    // "is the tool cache populated?". Covers the whole dispatch decision in
    // one line. (eventSink is required at construction, so always present.)
    const path = isTaskAugmented ? "task-augmented" : "inline";
    log.debug(
      "mcp",
      `execute source=${this.name} tool=${toolName}` +
        ` taskSupport=${taskSupport ?? "undefined"}` +
        ` path=${path}` +
        ` cachedTools=${this.cachedTools ? this.cachedTools.length : "null"}`,
    );

    try {
      return await withSpan(
        "tool.dispatch",
        {
          "tool.name": toolName,
          "tool.source": this.name,
          "tool.path": path,
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
      return this.handleExecuteError(err, toolName, dispatchArgs, signal, isTaskAugmented);
    }
  }

  /**
   * Map a thrown dispatch error to a terminal `ToolResult`. A client abort
   * emits a terminal `cancelled` progress event (task-augmented calls only) and
   * returns "Task cancelled" — the source is healthy, so no restart. Any other
   * throw routes through the shared `recover` (classify → surface / reauth /
   * restart + retry with bounded backoff).
   *
   *  - `idempotent: !isTaskAugmented` — a task-augmented call has spawned
   *    server-side state (the task, an entity, side effects); retrying would
   *    duplicate it. So `policyFor` surfaces every failure for tasks rather than
   *    retrying. Inline calls are re-issued with the SCRUBBED args
   *    (`dispatchArgs`), same as the direct call — the original `input` may carry
   *    no-op sentinels an upstream API rejects.
   *  - `reauth` — a remote with an OAuth provider flips to `reauth_required` and
   *    shows a structured "Reconnect"; a static-auth remote (no provider) has
   *    nothing to re-run, so `policyFor` surfaces it as a normal error.
   */
  private handleExecuteError(
    err: unknown,
    toolName: string,
    dispatchArgs: Record<string, unknown>,
    signal: AbortSignal | undefined,
    isTaskAugmented: boolean,
  ): ToolResult | Promise<ToolResult> {
    // Cancellation isn't a crash — the source is healthy, the client just asked
    // to stop. Emit a terminal tool.progress for task-augmented calls so UIs
    // watching the progress stream transition out of "working", then surface the
    // error to the agent without marking the source dead or triggering restart.
    const wasAborted = signal?.aborted === true;
    if (wasAborted) {
      if (isTaskAugmented) {
        this.eventSink.emit({
          type: "tool.progress",
          data: {
            source: this.eventSourceName,
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
        surface: (e) => {
          // Two things happen here.
          //
          // The throttle arm names the throttle rather than only reporting that
          // something broke, and gates the retry ADVICE on idempotency — a
          // task-augmented call has already spawned server-side state by the time
          // a mid-stream reopen can be throttled, so telling the agent to retry
          // would invite the duplicate side effects `policyFor`'s no-retry rule
          // exists to prevent.
          //
          // The infrastructure marker tells the loop supervisor not to count this
          // toward its strike budget — see `INFRA_ERROR_META_KEY` for why that
          // matters and why the marker is host-owned.
          //
          // It requires an allowlisted class AND that the throw is not an
          // `ProtocolError`. That second condition is stated as what it is — a
          // denylist of one type, not a proof of transport origin.
          //
          // It is load-bearing because three of the allowlisted classes are
          // decided by regex over the server's own error text: a connector answering
          // `ProtocolError(-32603, "Rate limit exceeded")` — FastMCP's default for an
          // unhandled exception — would otherwise exempt itself from the guard
          // permanently, and a connector relaying a persistent upstream 429 would be
          // exempted exactly when the guard should trip. An `ProtocolError` IS the
          // server answering, so it never earns the marker.
          //
          // Residual, deliberately accepted: a bare `Error` is not proof of
          // transport origin. `startToolAsTask` re-throws a task-creation failure
          // as `new Error(serverMessage)`, which this admits (#838). An allowlist
          // over throw TYPES would be worse, not better — `fetch failed` arrives
          // as a plain TypeError and a reset socket as a generic Error, so it
          // would drop exactly the cases this exists to mark.
          const kind = classifyConnectionFailure(e);
          const infra =
            INFRA_FAILURE_CLASSES.has(kind) &&
            !(e instanceof ProtocolError) &&
            !(e instanceof TaskWireError)
              ? infraErrorMeta()
              : {};
          if (kind === "rate-limited") {
            return {
              content: textContent(
                isTaskAugmented
                  ? `Task failed because ${this.name} is rate limited, and cannot be auto-retried — ` +
                      `it may have already started server-side. Do not re-issue it; check its status first. ` +
                      `Underlying error: ${errMessage(e)}`
                  : `${this.name} is rate limited — too many calls at once, and this call was refused before it ran. ` +
                      `The connector is healthy. Retry in a few seconds with FEWER calls in parallel (a handful at a time, ` +
                      `not a whole batch). Underlying error: ${errMessage(e)}`,
              ),
              isError: true,
              // `reason` only: `engine.ts` lifts it to `ToolCallRecord.errorReason`.
              // A sibling `error` field with the same value has no reader.
              structuredContent: {
                reason: "rate_limited",
                source: this.eventSourceName,
              },
              ...infra,
            };
          }
          return {
            content: textContent(
              isTaskAugmented
                ? `Task failed and cannot be auto-retried: ${errMessage(e)}`
                : `${this.name} call failed: ${errMessage(e)}`,
            ),
            isError: true,
            ...infra,
          };
        },
        reauth: () => ({
          content: textContent(
            `${this.name} needs to be reconnected — its authorization has expired. Open the connector and click Reconnect.`,
          ),
          isError: true,
          structuredContent: {
            error: "auth_required",
            reason: "reauth_required",
            source: this.eventSourceName,
          },
          // Deliberately NOT marked infrastructure, matching `not started` and the
          // absence of `auth-lost` from INFRA_FAILURE_CLASSES. One rule across all
          // three: a failure with no IN-RUN remedy still counts. `onAuthLost` only
          // records `reauth_required` — it does not stop the source or drop the
          // client — so every later call returns this same result, and exempting
          // it would leave the tool in the model's toolset for the rest of the run
          // with nothing able to fix it until a human clicks Reconnect.
        }),
      },
    );
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
    shape: RecoveryShape<T>,
  ): Promise<T> {
    const hasReauthableProvider = this.mode.type === "remote" && this.mode.authProvider != null;
    const delays = this.recoveryDelaysMs ?? shape.delays;
    let err = firstErr;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const outcome = this.recoveryOutcome<T>(err, shape, hasReauthableProvider);
      if (outcome) return outcome.value;
      // No terminal outcome → action was "recover": re-establish + retry,
      // riding the roll window.
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
    this.emitSourceCrashed(`recovery exhausted: ${errMessage(firstErr)}`);
    return shape.surface(err);
  }

  /**
   * Classify one recovery iteration for `err` and, where terminal, perform its
   * side-effect and return the caller's terminal representation wrapped in
   * `{ value }`. Returns null only for the `recover` action (re-establish +
   * retry), which the loop drives.
   *
   *  - **miss** (reads only) — the server answered "not here", an application
   *    outcome, not a connection failure. Checked first each iteration so a
   *    genuine miss discovered AFTER a successful re-establish stays a silent
   *    null instead of logging a spurious read failure.
   *  - **none** (`kind === "none"`) — app/protocol/unknown; a restart won't help.
   *  - **reauth** — flip the connection to `reauth_required` and surface Reconnect.
   *  - **surface** — give up. Mark the source crashed ONLY for a genuine
   *    connection-down class we won't retry (session-lost / transient /
   *    transport-dead), so HealthMonitor heals it for later calls. A `timeout`
   *    (slow tool, healthy transport), `auth-lost` (a credential problem), and
   *    `rate-limited` (a healthy transport being paced) are NOT the transport
   *    crashing — restarting for them would tear the source down for its other
   *    tools (the #581 cascade), so they surface without it.
   */
  private recoveryOutcome<T>(
    err: unknown,
    shape: RecoveryShape<T>,
    hasReauthableProvider: boolean,
  ): { value: T } | null {
    if (shape.miss && isMcpResourceMiss(err)) return { value: shape.miss(err) };
    const classified = classifyConnectionFailure(err);
    // An `unknown` throw is recoverable only where the caller opts in (tool
    // path); elsewhere it's surfaced like a protocol error.
    const kind =
      classified === "unknown" ? (shape.recoverUnknown ? "transport-dead" : "none") : classified;
    if (kind === "none") return { value: shape.surface(err) };
    const action = policyFor(kind, { idempotent: shape.idempotent, hasReauthableProvider });
    if (action === "reauth") {
      this.flagAuthLost();
      return { value: shape.reauth(err) };
    }
    if (action === "surface") {
      if (isConnectionDownClass(kind)) this.emitSourceCrashed(String(err));
      return { value: shape.surface(err) };
    }
    return null; // action === "recover"
  }

  /** If this is a remote source with a reauthable provider, flag its auth lost. */
  private flagAuthLost(): void {
    if (this.mode.type === "remote" && this.mode.authProvider) {
      this.mode.authProvider.notifyAuthLost();
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
  async readResource(
    uri: string,
    opts?: { logFailures?: boolean; reconnect?: boolean },
  ): Promise<ResourceData | null> {
    if (!this.client) {
      // A torn-down client (a source degraded/crashed without re-creation) is the
      // persistent silent-404 shape — the most likely cause of a read that stays
      // broken until a full runtime restart. App-surface reads (the ui:// proxy
      // passes `reconnect`) attempt an on-demand reconnect first so the dead window
      // self-heals; discovery/composition probes (no `reconnect`) legitimately race
      // a not-yet-started/tearing-down client and stay cheap. Only when no client is
      // available do we log (on the app-surface path) and return the null.
      if (!(opts?.reconnect && (await this.reconnectOnDemand()))) {
        if (opts?.logFailures) {
          log.warn("[mcp] readResource: source has no active client connection", {
            uri,
            source: this.name,
          });
        }
        return null;
      }
    }
    // `reconnectOnDemand()` returns true only with a live client, but narrow for the
    // compiler (and defend a race that re-nulled it) before the read below.
    if (!this.client) return null;
    // A real failure (a torn transport, a dropped connection, an exhausted
    // recovery) is NOT a missing resource — log it ONLY on the app-surface path
    // (the resource proxy passes `logFailures`), where a failure is anomalous.
    // Discovery probes stay silent so a connector that simply lacks a probed
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
          // (ZodError) or a server-defined code must NOT restart-storm the whole
          // source — surface it as a null. Recognized transport failures and
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

  /**
   * Whether skill discovery asks this server for `skills/list` (SEP-2640).
   *
   * - `declared`: the server advertised `io.modelcontextprotocol/skills`
   *   ({@link serverExtensions}, from `server/discover` or `initialize`).
   *   Declaring is what commits a server to the method.
   * - `none`: a 2026-07-28 connection without the declaration. The
   *   extensions a modern server advertises are complete, so it has no skills.
   * - `probe`: a 2025-era remote connection without the declaration (an
   *   in-process source is the platform's own app and is `none`). Some SDKs omit
   *   `capabilities.extensions` from the legacy `initialize` result (the
   *   Python `mcp` SDK does), so a server that serves the extension cannot say
   *   so there. Discovery asks once per window, and a server that does not
   *   know the method means none: `-32601`, or `-32602` from the Python SDK,
   *   which rejects an unknown method as a request that failed validation.
   *
   * This decides only whether to ask. What is a skill still comes from the
   * server's own listing, never from a resource's URI scheme, which is the
   * inference SEP-2640 forbids.
   */
  skillsDiscovery(): "declared" | "probe" | "none" {
    if (SKILLS_EXTENSION_ID in this.serverExtensions()) return "declared";
    // An in-process source is the platform's own app: its skills reach the
    // model through the skills source and the filesystem pool, so an
    // undeclared one is never asked.
    if (this.mode.type === "inProcess") return "none";
    return this.protocolEra === "modern" ? "none" : "probe";
  }

  /**
   * Enumerate the server's skills via `skills/list` (SEP-2640), best-effort.
   *
   * Call only when {@link skillsDiscovery} is not `none`. Entries come back
   * unvalidated, for the caller to check one at a time. On a `probe`, a
   * `-32601` or `-32602` answer to the first page is a complete, empty
   * listing: the server does not serve the extension. Otherwise a failed call leaves a
   * partial result (`ok: false`), and the 10-page cap can stop the walk with
   * a cursor outstanding (`truncated: true`); either way the result is not the
   * server's whole listing, and a caller must not cache it as complete.
   * Failures do not route through session recovery: this is a discovery probe,
   * and a misbehaving server must not restart-storm the source.
   */
  async listSkills(): Promise<{ entries: unknown[]; ok: boolean; truncated: boolean }> {
    if (!this.client) return { entries: [], ok: false, truncated: false };
    const probing = this.skillsDiscovery() === "probe";
    const entries: unknown[] = [];
    let cursor: string | undefined;
    let page = 0;
    try {
      for (; page < 10; page++) {
        // A raw request validated by our own schema, not the SDK's typed
        // `skills/list`: SDK v2 strips `resultType` from a result before
        // validating it against a schema that requires it, so it rejects every
        // conforming `skills/list` result (modelcontextprotocol/typescript-sdk#2789).
        const result = await this.client.request(
          { method: SKILLS_LIST_METHOD, params: cursor ? { cursor } : {} },
          SkillsListResultSchema,
        );
        entries.push(...result.skills);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      if (cursor) {
        log.warn("[mcp] listSkills hit the 10-page cap; later skills not enumerated", {
          source: this.name,
        });
        return { entries, ok: true, truncated: true };
      }
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      // Unknown method: `-32601` per JSON-RPC, `-32602` from the Python SDK,
      // which validates a request against its known methods before routing.
      // Only on an undeclared probe: from a declaring server either is a failure.
      if (probing && page === 0 && (code === -32601 || code === -32602)) {
        return { entries: [], ok: true, truncated: false };
      }
      return { entries, ok: false, truncated: false };
    }
    return { entries, ok: true, truncated: false };
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
      // hints from the connector — e.g. the supervisor's non-advancing marker —
      // reach the engine instead of being dropped at this projection.
      _meta: hostOwnedMetaStripped((result as { _meta?: Record<string, unknown> })._meta, {
        inProcess: this.mode.type === "inProcess",
      }),
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
      // hints from the connector reach the engine — same as the inline path.
      _meta: hostOwnedMetaStripped((callToolResult as { _meta?: Record<string, unknown> })._meta, {
        inProcess: this.mode.type === "inProcess",
      }),
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

    const taskClient = this.taskClient;
    if (!taskClient) throw new Error(`McpSource "${this.name}" has no task client`);
    const stream = taskClient.callToolStream(
      { name: toolName, arguments: args },
      {
        signal: abortController.signal,
        ttlMs: opts.ttlMs ?? DEFAULT_TASK_TTL_MS,
        createTimeoutMs: TASK_CREATED_TIMEOUT_MS,
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
    const firstMsg: TaskStreamMessage = first.value;
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
    const taskClient = this.taskClient;
    if (taskClient) {
      try {
        const upstream = await taskClient.getTask(taskId);
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
    stream: AsyncGenerator<TaskStreamMessage, void, void>,
    toolName: string,
  ): Promise<void> {
    try {
      for await (const message of stream) {
        switch (message.type) {
          case "taskStatus":
            this.applyTaskStatus(handle, message.task, toolName);
            break;
          case "taskCreated":
            // `startToolAsTask` already consumed the first taskCreated.
            // A second one would be a protocol oddity; ignore gracefully.
            break;
          case "result":
            if (this.settleTaskResult(handle, message.result)) return;
            break;
          case "error":
            await this.settleTaskError(handle, message.error);
            return;
        }
      }
      this.settleStreamEndedWithoutTerminal(handle);
    } catch (err) {
      this.settleDrainerThrow(handle, err);
    }
  }

  /**
   * `taskStatus`: refresh `handle.latestTask` + expiry and emit a live
   * `tool.progress`. No-op when the message carried no task.
   */
  private applyTaskStatus(handle: TaskHandle, task: Task | undefined, toolName: string): void {
    if (!task) return;
    handle.latestTask = task;
    handle.expiresAt = computeExpiry(task);
    this.eventSink.emit({
      type: "tool.progress",
      data: {
        source: this.name,
        tool: toolName,
        taskId: handle.taskId,
        status: task.status,
        message: task.statusMessage,
      },
    });
  }

  /**
   * `result`: mark the handle terminal-completed and resolve. Returns true when
   * settled; false (keep draining) when the message carried no result.
   */
  private settleTaskResult(handle: TaskHandle, result: CallToolResult | undefined): boolean {
    if (!result) return false;
    handle.terminal = { result };
    handle.latestTask = {
      ...handle.latestTask,
      status: "completed",
      lastUpdatedAt: new Date().toISOString(),
    };
    handle.expiresAt = Date.now() + TASK_HANDLE_GRACE_MS;
    handle.terminalDeferred.resolve(result);
    return true;
  }

  /**
   * `error` (always terminal). Two sub-cases:
   *   1. A caller invoked `cancelTask(...)` → per task 001 acceptance criteria,
   *      in-flight `awaitToolTaskResult` callers must be rejected with a
   *      descriptive error.
   *   2. Clean stream-level `error` from the server (task failed without
   *      cancellation) → resolve with `isError: true` so the agent-loop wrapper
   *      preserves its historical return shape. Rejection is reserved for
   *      transport crashes / protocol violations so `execute()`'s catch branch
   *      makes the right restart decision.
   *
   * Contract: even when `recoverFailedTaskResult` salvages a payload,
   * `latestTask.status` reflects what the SERVER reported (`failed`/`cancelled`)
   * — the recovery only salvages the agent-visible content, not the terminal
   * verdict. Status consumers see the honest server state; the agent sees the
   * actual output.
   */
  private async settleTaskError(
    handle: TaskHandle,
    error: { message?: string } | undefined,
  ): Promise<void> {
    const message = error?.message ?? `Task ${handle.taskId} failed`;
    if (handle.cancelRequested) {
      const err = new Error(`Task ${handle.taskId} cancelled: ${message}`);
      handle.terminal = { error: err };
      handle.latestTask = {
        ...handle.latestTask,
        status: "cancelled",
        statusMessage: message,
        lastUpdatedAt: new Date().toISOString(),
      };
      handle.expiresAt = Date.now() + TASK_HANDLE_GRACE_MS;
      handle.terminalDeferred.reject(err);
      return;
    }
    const isAborted = handle.abortController.signal.aborted;
    const recoveredResult = await this.recoverFailedTaskResult(handle, message, isAborted);
    const callToolResult: CallToolResult = recoveredResult ?? {
      content: [{ type: "text", text: message }],
      isError: true,
    };
    handle.terminal = { result: callToolResult };
    handle.latestTask = {
      ...handle.latestTask,
      status: isAborted ? "cancelled" : "failed",
      statusMessage: message,
      lastUpdatedAt: new Date().toISOString(),
    };
    handle.expiresAt = Date.now() + TASK_HANDLE_GRACE_MS;
    handle.terminalDeferred.resolve(callToolResult);
  }

  /**
   * Defense in depth: the task stream emits `type: 'error'` with the message
   * `Task <id> failed` whenever a 2025-era task's server-side status is
   * `failed`, without reading the server's `tasks/result` payload. A connector
   * that misclassified its own terminal status —
   * e.g. a post-result exception flipping COMPLETED→FAILED while a usable payload
   * already existed in the store — would surface to the agent as a useless string
   * with the real output gone. Try one extra `tasks/result` fetch before settling
   * for the generic error. Returns null when no result is genuinely available.
   *
   * Discriminator: `endsWith` on the known `handle.taskId`, NOT a regex on the
   * bare message. Using the taskId as the discriminator also tightens specificity: we won't
   * accidentally recover on a connector-authored error that mentions a different
   * task.
   */
  private async recoverFailedTaskResult(
    handle: TaskHandle,
    message: string,
    isAborted: boolean,
  ): Promise<CallToolResult | null> {
    const isGenericTaskFailed = message.endsWith(`Task ${handle.taskId} failed`);
    const taskClient = this.taskClient;
    if (isAborted || !taskClient || taskClient.era !== "legacy" || !isGenericTaskFailed)
      return null;
    try {
      const recovered = await taskClient.getTaskResult(handle.taskId);
      log.debug("mcp", `recovered tasks/result for failed task ${handle.taskId} on ${this.name}`);
      return recovered;
    } catch {
      // No result genuinely available — caller falls through to the generic error.
      return null;
    }
  }

  /** Stream ended without a terminal message — protocol violation; reject. */
  private settleStreamEndedWithoutTerminal(handle: TaskHandle): void {
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
  }

  /**
   * Transport crash or abort thrown out of the drain loop. The outer
   * `execute()` catch surfaces this to the agent loop; here we just leave the
   * handle in a defensible state for post-mortem inspection and reject.
   */
  private settleDrainerThrow(handle: TaskHandle, thrown: unknown): void {
    const err = toError(thrown);
    const wasAborted = handle.abortController.signal.aborted;
    handle.terminal = { error: err };
    handle.latestTask = {
      ...handle.latestTask,
      status: wasAborted ? "cancelled" : "failed",
      statusMessage: err.message,
      lastUpdatedAt: new Date().toISOString(),
    };
    handle.expiresAt = Date.now() + TASK_HANDLE_GRACE_MS;
    handle.terminalDeferred.reject(err);
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
      this.toolsFetchedAt = null;
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
 * Whether a connect failed because the `server/discover` probe met an HTTP 500
 * — the one probe failure a 2025-era server can cause just by being strict
 * about methods it does not know. Only 500: it is the server's own answer.
 * A 502, 503 or 504 comes from a proxy or gateway in front of the server (an
 * edge whose upstream is restarting) and says nothing about the server's era;
 * falling back on one would pin a 2026-07-28 server to the 2025 era for the
 * life of the connection, and a 2026-only feature (the tasks extension) with
 * it. Auth refusals and network failures are excluded too: those fail the
 * legacy handshake the same way.
 *
 * The cost: a strict 2025-era server whose host turns its 500 into a 502 (an
 * unhandled throw in a function behind a gateway, such as AWS Lambda behind
 * API Gateway) never connects, and every re-probe fails with that 502.
 */
function isEraProbeServerFailure(err: unknown): boolean {
  return (
    err instanceof SdkHttpError &&
    err.code === SdkErrorCode.EraNegotiationFailed &&
    err.status === 500
  );
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
  | "rate-limited"
  | "timeout"
  | "unknown"
  | "none";

/**
 * Classify a thrown error into a connection-failure class. Order matters:
 * `session-lost` (by message) is checked first, then the `-32001` `timeout`, then
 * `rate-limited`, `transient`, `auth-lost`, the standard protocol codes, and
 * recognized torn-transport shapes, with `unknown` as the residue.
 *
 * - **session-lost** — the server forgot our Streamable-HTTP session (it rolled).
 *   Matched on the "session not found" MESSAGE, NOT the HTTP status or code: the
 *   fleet servers' Python SDK returns it as HTTP 404 with a
 *   `{"code":-32600,"message":"Session not found"}` body (so the client's
 *   `SdkHttpError.code` is 404 and the `-32600` is body text), but remote
 *   connectors are untrusted/heterogeneous — the message is the reliable signal.
 * - **timeout** — `SdkError(RequestTimeout)` (or a peer's `-32001`): the request was sent
 *   but the response is slow (the tool, not the transport). Surfaces, never
 *   restarts — restarting strands the source's other tools without speeding the
 *   slow one (#581). Checked after the session message so a `-32001` carrying
 *   session text still classifies session-lost.
 * - **rate-limited** — a gateway refused the request for PACING (429 /
 *   `rate_limited`). The transport is healthy and the same connection serves the
 *   next call; only the caller's rate is wrong. Surfaces, never restarts — see the
 *   branch comment for why restarting here is actively harmful.
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
 *   now capped); the read path surfaces it (a malformed result / server code
 *   must NOT restart-storm the whole source). This split is why `unknown` is
 *   distinct from `transport-dead` — see `recover`'s `recoverUnknown`.
 */
export function classifyConnectionFailure(err: unknown): ConnectionFailure {
  if (err === null || typeof err !== "object") return "none";
  const code = (err as { code?: unknown }).code;
  // An HTTP status: the SDK's HTTP failures carry it beside a string code; a
  // numeric code in the HTTP range is one a caller's own throw carried.
  const status = err instanceof SdkHttpError ? err.status : code;
  const message = (err as { message?: unknown }).message;
  const msg = typeof message === "string" ? message : "";

  // session-lost — checked first (most specific). Match the "session not found"
  // MESSAGE regardless of the HTTP status / JSON-RPC code, because the signal is
  // the server's text, not the envelope: the fleet servers' Python MCP SDK returns
  // it as HTTP 404 with a `{"code":-32600,"message":"Session not found"}` body
  // (so the SDK client's SdkHttpError has `code === 404`), but a remote
  // connector is untrusted and heterogeneous — another server (or the same one in
  // HTTP-200 + JSON-RPC-error mode) could surface it as `ProtocolError(-32600)` or a
  // non-404 status. Gating on the status would silently strand those. Matching the
  // message also takes precedence over the `-32600 → none` branch below, so a
  // session loss carrying the -32600 code still recovers instead of surfacing.
  if (/session not found/i.test(msg)) {
    return "session-lost";
  }
  // timeout — the SDK throws `SdkError(RequestTimeout)` (or a peer's `-32001`) when a call
  // exceeds the request timeout. This is NOT a session loss (that's the message
  // above) and NOT a transport crash: the request was sent, the response is just
  // slow. Restarting abandons the in-flight call and tears the source down for
  // every other tool, but can't make a slow tool faster — so it surfaces (policy),
  // never restarts. A transport that actually closes or errors still recovers via
  // its own signal (onclose → `emitSourceCrashed`; ECONNRESET / "fetch failed" /
  // -32000 → `transport-dead`). NOTE there is no liveness probe, so a half-open
  // socket whose ONLY symptom is a client-side -32001 is not auto-reaped today —
  // but restarting wouldn't speed up a slow tool anyway (that IS the #581 cascade);
  // a real liveness probe is the fix for that narrow case. Checked after the
  // session-message match so an artificial -32001+session-text still classifies
  // session-lost. (See #581 — a tool timeout was cascading connector restarts in prod.)
  if (code === SdkErrorCode.RequestTimeout || code === -32001) {
    return "timeout";
  }
  // rate-limited — a gateway refused the request for pacing, not because anything
  // is broken. The transport is HEALTHY: the same connection will serve the next
  // call once the caller slows down. Without this class the throw falls to
  // `unknown`, which the tool path maps to `transport-dead` → a full stop()/start().
  // That is worse than a wasted restart: `stop()` aborts every in-flight stream on
  // the source, so ONE throttled call in a parallel batch tears the transport out
  // from under its siblings — including calls the server already committed.
  // Checked BEFORE the torn-transport regex below, which is broad enough to be a
  // magnet for anything left unclassified.
  //
  // Both signals are load-bearing, for DIFFERENT reasons:
  //
  //  - `code` catches the transport's own throws. `SdkHttpError` sets
  //    `code = response.status`, so a refused POST and a refused mid-stream SSE
  //    reopen both arrive carrying a real numeric 429.
  //  - the MESSAGE catches the paths where that code is already gone.
  //    `startToolAsTask` re-throws a task-creation failure as a bare
  //    `new Error(firstMsg.error?.message)`, keeping the server's text and
  //    dropping everything else. Heterogeneous remotes are the second reason —
  //    the same one that makes session-lost match on text.
  //
  // The `rate limit` stem is deliberately left unanchored: `rate_limit_exceeded`
  // is a common spelling and `_` is a word character, so a trailing `\b` could
  // never match it. A BARE `429` is still not matched — it collides with the port
  // fragments in transport error text (`127.0.0.1:429`) — so the status is read
  // from a message only where a keyword qualifies it.
  if (
    status === 429 ||
    /\brate[ _-]?limit|\bthrottl(e|ed|ing)\b|\btoo many requests\b|\b(?:http|status(?:Code)?|code)["' :=]*429\b/i.test(
      msg,
    )
  ) {
    return "rate-limited";
  }
  // transient — a mid-roll gateway blip (502/503/504, `bad_gateway`). Back off.
  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
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
  if (isTornTransport(code, msg)) return "transport-dead";
  // Couldn't positively classify it — let the caller decide (recover vs surface).
  return "unknown";
}

/**
 * A recognized torn-transport shape. `ConnectionClosed` is the SDK's own
 * connection-closed code; -32000 is the one a peer's JSON-RPC body carries.
 */
function isTornTransport(code: unknown, msg: string): boolean {
  return (
    code === SdkErrorCode.ConnectionClosed ||
    code === -32000 ||
    /connection closed|fetch failed|socket hang ?up|terminated|network error|econnre(set|fused)|timed? ?out|epipe|broken pipe/i.test(
      msg,
    )
  );
}

/**
 * The connection-down classes `recover` marks crashed before surfacing (so
 * HealthMonitor heals the source for later calls). `timeout` (slow tool, healthy
 * transport), `auth-lost` (a credential problem), and `rate-limited` (a healthy
 * transport being paced) are excluded — restarting for them would tear the source
 * down for its other tools (the #581 cascade). Marking a throttled source crashed
 * is the same mistake one layer down: HealthMonitor would answer the throttle with
 * a burst of five reconnects into the gateway that just asked for less traffic.
 */
function isConnectionDownClass(kind: ConnectionFailure): boolean {
  return kind === "session-lost" || kind === "transient" || kind === "transport-dead";
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
  // A request timeout never restarts (the tool is slow, not the transport broken;
  // restarting would tear the source down for its other tools). Surface it so the
  // agent can decide — retry a smaller batch, or the tool should be task-augmented.
  if (kind === "timeout") return "surface";
  // A rate limit never restarts either, and for a strictly stronger reason than
  // timeout: re-establishing spends MORE of the very budget that was just refused
  // (a fresh `initialize` + `tools/list` on top of the retry), so the restart both
  // fails to help and deepens the throttle. Surface it and let the caller pace
  // itself — the transport was never the problem.
  if (kind === "rate-limited") return "surface";
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
 * Cooldown floor (ms) for the app-surface on-demand reconnect
 * ({@link McpSource.reconnectOnDemand}). Bounds how often a torn-down source is
 * stop()/start()-cycled from foreground execute/read calls when the upstream is
 * persistently unreachable, so it never out-paces (and defeats) HealthMonitor's
 * slower re-probe schedule. Only a FAILED attempt is floored — a healthy
 * idle-close reconnects on the first call with no delay.
 */
const RECONNECT_COOLDOWN_MS = 30_000;

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

/**
 * Classes that mean the call never reached the tool's logic, so repeating it says
 * nothing about whether the tool works. Necessary but NOT sufficient for the
 * infrastructure marker — the throw must also be transport-level; see the call
 * site and {@link INFRA_ERROR_META_KEY}.
 *
 * An allowlist, so `unknown` and `none` count and a new `ConnectionFailure`
 * member is not silently exempt. `timeout` and `auth-lost` are absent: both
 * arrive as `ProtocolError`, and both describe a failure with no in-run remedy, which
 * still counts.
 */
const INFRA_FAILURE_CLASSES: ReadonlySet<ConnectionFailure> = new Set([
  "session-lost",
  "transient",
  "transport-dead",
  "rate-limited",
]);

/**
 * `_meta` marking a result as an infrastructure failure — the call never reached
 * the tool's logic, or its answer never came back. The loop supervisor excludes
 * these from its strike count; see `INFRA_ERROR_META_KEY` for why.
 *
 * A fresh object per call: `_meta` is spread into caller-owned results, and a
 * shared literal would let one consumer's mutation leak into every other result.
 */
function infraErrorMeta(): { _meta: Record<string, unknown> } {
  return { _meta: { [INFRA_ERROR_META_KEY]: true } };
}

/**
 * Drop host-owned keys from `_meta` that arrived over the wire.
 *
 * The rule every `ai.nimblebrain/*` `_meta` key follows:
 *
 *   - A key is HOST-OWNED when the engine acts on it. The host's own sources set
 *     it; a connector's copy is stripped here, so a server cannot steer the
 *     engine by claiming one.
 *   - A key is ACCEPTED from a connector only when believing it can make the host
 *     stricter toward that connector and never looser, and only once something
 *     reads it. Everything else in `_meta` is forwarded verbatim.
 *   - No key ships without a named reader.
 *
 * Every key the engine reads is host-owned today:
 *
 * `INFRA_ERROR_META_KEY` is stripped unconditionally, in-process included: the
 * supervisor trusts it to exempt an error from its strike count, so a source
 * setting it on its own errors would escape the loop guard permanently. Only
 * `McpSource` itself sets it, on failures it observed in transport.
 *
 * `NON_ADVANCING_META_KEY`, `SKILL_ACTIVATED_META_KEY`, and
 * `SKILL_SUPPRESSION_META_KEY` are stripped from every source that crosses a real
 * transport; in-process sources (`inProcess: true`: the platform's own tools,
 * such as `nb__search` and the skill tools, which legitimately emit them) carry
 * them through. A connector setting the skill keys could mute curated guidance
 * by name. Accepting the non-advancing key from a connector could only tighten
 * the guard on that connector, but no connector sets it, and accepting it would
 * make the supervisor's internals a contract with every server.
 */
function hostOwnedMetaStripped(
  meta: Record<string, unknown> | undefined,
  opts: { inProcess: boolean },
): Record<string, unknown> | undefined {
  if (!meta) return meta;
  let out = meta;
  if (INFRA_ERROR_META_KEY in out) {
    const { [INFRA_ERROR_META_KEY]: _droppedInfra, ...rest } = out;
    out = rest;
  }
  if (!opts.inProcess && NON_ADVANCING_META_KEY in out) {
    const { [NON_ADVANCING_META_KEY]: _droppedNonAdvancing, ...rest } = out;
    out = rest;
  }
  if (!opts.inProcess && SKILL_ACTIVATED_META_KEY in out) {
    const { [SKILL_ACTIVATED_META_KEY]: _droppedActivation, ...rest } = out;
    out = rest;
  }
  if (!opts.inProcess && SKILL_SUPPRESSION_META_KEY in out) {
    const { [SKILL_SUPPRESSION_META_KEY]: _droppedSuppression, ...rest } = out;
    out = rest;
  }
  return out;
}

/** Extract a human-readable message from an unknown throw. */
function errMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Normalize an unknown throw into an Error (wrapping non-Errors verbatim). */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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
