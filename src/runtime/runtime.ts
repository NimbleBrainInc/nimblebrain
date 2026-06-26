import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LanguageModelV3,
  LanguageModelV3Message,
  LanguageModelV3TextPart,
} from "@ai-sdk/provider";
import { MetricsEventSink } from "../adapters/metrics-events.ts";
import { NoopEventSink } from "../adapters/noop-events.ts";
import { WorkspaceLogSink } from "../adapters/workspace-log-sink.ts";
import { recordLlmUsage } from "../api/metrics.ts";
import type { AutomationDomainContext } from "../bundles/automations/src/domain.ts";
import { sanitizePlacements } from "../bundles/defaults.ts";
import { BundleLifecycleManager } from "../bundles/lifecycle.ts";
import { setConnectionRunningHandler } from "../bundles/pending-auth-buffer.ts";
import type { BundleMcpDeps } from "../bundles/startup.ts";
import type { AppInfo, BundleInstance, PlacementDeclaration } from "../bundles/types.ts";
import { isToolVisibleToRole, type ResolvedFeatures, resolveFeatures } from "../config/features.ts";
import { deriveOverridePath } from "../config/overrides.ts";
import { createPrivilegeHook, NoopConfirmationGate } from "../config/privilege.ts";
import { generateTitle } from "../conversation/auto-title.ts";
import { compactConversationMessages } from "../conversation/compaction.ts";
import { EventSourcedConversationStore } from "../conversation/event-sourced-store.ts";
import { JsonlConversationStore } from "../conversation/jsonl-store.ts";
import { ConversationLocator } from "../conversation/locator.ts";
import { InMemoryConversationStore } from "../conversation/memory-store.ts";
import { roomConversationsDir, runConversationsDir } from "../conversation/paths.ts";
import type {
  Conversation,
  ConversationAccessContext,
  ConversationEvent,
  ConversationListResult,
  ConversationStore,
  CreateConversationOptions,
  ListOptions,
  StoredMessage,
} from "../conversation/types.ts";
import {
  applyReasoningReplayPolicy,
  sliceHistory,
  windowMessages,
} from "../conversation/window.ts";
import { AgentEngine } from "../engine/engine.ts";
import { estimateMessageTokens, estimateToolDescriptionTokens } from "../engine/token-estimate.ts";
import type {
  ConnectorSkillCandidate,
  ContextAssembledPayload,
  ContextAssembledSource,
  EngineConfig,
  EngineEvent,
  EngineHooks,
  EngineResult,
  EventSink,
  SkillsLoadedPayload,
  ToolPromotionResult,
  ToolRouter,
  ToolSchema,
} from "../engine/types.ts";
import { CONNECTOR_SKILL_SYNTHETIC } from "../engine/types.ts";
import { rehydrateUserResources } from "../files/rehydrate.ts";
import { createFileStore, type FileStore } from "../files/store.ts";
import { DEFAULT_FILE_CONFIG, type FileConfig } from "../files/types.ts";
import { FileBackedHostResourcesResolver, TokenBucketRateLimit } from "../host-resources/index.ts";
import { IdentityContext } from "../identity/context.ts";
import type { InstanceConfig } from "../identity/instance.ts";
import { loadInstanceConfig } from "../identity/instance.ts";
import { resolveRequestOwnerId } from "../identity/owner.ts";
import type { IdentityProvider, UserIdentity } from "../identity/provider.ts";
import { createIdentityProvider } from "../identity/provider.ts";
import { DEV_IDENTITY } from "../identity/providers/dev.ts";
import { UserStore } from "../identity/user.ts";
import { InstructionsStore } from "../instructions/index.ts";
import { getModelByString, getProviderFromModel } from "../model/catalog.ts";
import { buildModelResolver, resolveModelString } from "../model/registry.ts";
import { registerBuiltinCredentialProviders } from "../oauth/minted-credential-provider.ts";
import { requestIdentityAttrs, withSpan } from "../observability/index.ts";
import { log } from "../observability/log.ts";
import { PermissionStore } from "../permissions/permission-store.ts";
import type {
  AppStateInfo,
  FocusedAppInfo,
  Layer3SkillEntry,
  PromptAppInfo,
} from "../prompt/compose.ts";
import { composeSystemSegments } from "../prompt/compose.ts";
import { ConnectorDirectory } from "../registries/directory.ts";
import { RegistryStore, warnIfCuratedCatalogEmpty } from "../registries/registry-store.ts";
import { synthesizeBundleSkill } from "../skills/bundle-skills.ts";
import {
  CONNECTOR_SKILLS_SUBDIR,
  type ConnectorOverlayInfo,
  listConnectorOverlays,
  readConnectorSkillCandidates,
} from "../skills/connector-skill-store.ts";
import {
  loadBuiltinSkills,
  loadCoreSkills,
  loadScopedSkills,
  loadSkillDir,
  mergeScopedSkills,
  partitionSkills,
} from "../skills/loader.ts";
import { SkillMatcher } from "../skills/matcher.ts";
import { partitionSkillsByRole, type SelectedSkill, selectLayer3Skills } from "../skills/select.ts";
import { approxTokens } from "../skills/tokens.ts";
import { MAX_SKILL_BODY_CHARS, truncateMarkdownToBudget } from "../skills/truncate.ts";
import type { Skill } from "../skills/types.ts";
import { TelemetryManager } from "../telemetry/manager.ts";
import { PostHogEventSink } from "../telemetry/posthog-sink.ts";
import type { DelegateContext } from "../tools/delegate.ts";
import { isIdentitySource } from "../tools/identity-sources.ts";
import { McpSource } from "../tools/mcp-source.ts";
import { namespacedToolName } from "../tools/namespace.ts";
import { SharedSourceRef, type ToolRegistry } from "../tools/registry.ts";
import { surfaceTools } from "../tools/surfacing.ts";
import { createSystemTools } from "../tools/system-tools.ts";
import type { ResourceData, Tool, ToolSource } from "../tools/types.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { ensureUserWorkspace } from "../workspace/provisioning.ts";
import { personalWorkspaceIdFor, WorkspaceStore } from "../workspace/workspace-store.ts";
import { ConversationAccessDeniedError, RunInProgressError } from "./errors.ts";
import { IdentityToolRouter } from "./identity-tool-router.ts";
import { PlacementRegistry } from "./placement-registry.ts";
import {
  getRequestContext,
  type RequestContext,
  runWithRequestContext,
} from "./request-context.ts";
import { type BufferedRunEvent, RunBus } from "./run-bus.ts";
import { buildSkillsLoadedPayload } from "./skills-loaded-payload.ts";
import type {
  ChatRequest,
  ChatResult,
  ModelSlots,
  RuntimeConfig,
  TaskRequest,
  TaskResult,
  TurnUsage,
} from "./types.ts";
import { createWorkspaceRegistry, startWorkspaceBundles } from "./workspace-runtime.ts";

const DEFAULT_WORK_DIR = join(homedir(), ".nimblebrain");
const DEFAULT_MODEL = "claude-sonnet-4-6";

import { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_ITERATIONS } from "../limits.ts";
import { resolveMaxOutputTokens } from "./resolve-max-output-tokens.ts";
import { resolveMessageBudget } from "./resolve-message-budget.ts";
import { resolveThinking } from "./resolve-thinking.ts";
import { isToolEligibleForPromotion } from "./tool-eligibility.ts";

const DEFAULT_MAX_HISTORY_MESSAGES = 40;

/** Known model slot names. */
const MODEL_SLOTS = ["default", "fast", "reasoning"] as const;
type ModelSlot = (typeof MODEL_SLOTS)[number];

const ALIAS_PREFIX = "alias:";

/** Check if a string is an alias reference (e.g., "alias:fast"). */
function isAliasRef(s: string): boolean {
  return s.startsWith(ALIAS_PREFIX);
}

/** Extract the slot name from an alias reference. Returns null if not a valid slot. */
function parseAliasRef(s: string): ModelSlot | null {
  if (!isAliasRef(s)) return null;
  const slot = s.slice(ALIAS_PREFIX.length);
  return MODEL_SLOTS.includes(slot as ModelSlot) ? (slot as ModelSlot) : null;
}

function resolveWorkDir(config: RuntimeConfig): string {
  if (config.workDir) return config.workDir;
  // Hard guard: under `bun test` (NODE_ENV=test is set automatically by the
  // bun test runner), defaulting to `~/.nimblebrain` would pollute the
  // developer's real workdir with test conversations / workspaces / bundles.
  // Force every test to pass an explicit (typically tmpdir-based) workDir.
  // Without this, a test that forgets `workDir` silently writes echo-model
  // conversations into the user's dev environment and they show up in the
  // real app's conversations tab.
  if (process.env.NODE_ENV === "test") {
    throw new Error(
      "Runtime.start({}) called without `workDir` under bun test. " +
        "Pass an explicit tmpdir-based workDir to avoid polluting the developer's ~/.nimblebrain. " +
        "Example: workDir: join(tmpdir(), 'nb-test-' + Date.now()).",
    );
  }
  return DEFAULT_WORK_DIR;
}

function globalSkillDir(config: RuntimeConfig): string {
  return join(resolveWorkDir(config), "skills");
}

/** Multi-event sink that fans out to multiple sinks. */
class MultiEventSink implements EventSink {
  constructor(private sinks: EventSink[]) {}
  emit(event: EngineEvent): void {
    for (const sink of this.sinks) sink.emit(event);
  }
}

/**
 * Tracks parent engine run state for delegate context.
 * Listens to engine events to maintain current runId and iteration count.
 */
class DelegateTracker implements EventSink {
  private currentRunId = "";
  private currentIteration = 0;
  private maxIterations = 10;

  emit(event: EngineEvent): void {
    if (event.type === "run.start") {
      // Only track top-level runs (no parentRunId)
      if (!event.data.parentRunId) {
        this.currentRunId = event.data.runId as string;
        this.maxIterations = event.data.maxIterations as number;
        this.currentIteration = 0;
      }
    } else if (event.type === "llm.done") {
      // Only track top-level LLM calls (no parentRunId)
      if (!event.data.parentRunId) {
        this.currentIteration++;
      }
    }
  }

  getParentRunId(): string {
    return this.currentRunId;
  }

  getRemainingIterations(): number {
    return this.maxIterations - this.currentIteration;
  }
}

export class Runtime {
  private resolveModelFn: (modelString: string) => LanguageModelV3;
  private store: ConversationStore;
  private skillMatcher: SkillMatcher;
  private config: RuntimeConfig;
  private contextSkills: Skill[];
  private eventStore: EventSourcedConversationStore | null;
  /** Process-wide convId → room resolver; lazily built over the workspaces root. */
  private _conversationLocator?: ConversationLocator;
  /** Subscribers (e.g. the conversations-tool index) notified on any conversation change. */
  private _conversationsChangedListeners = new Set<() => void>();
  private hooks: EngineHooks;
  private defaultEvents: EventSink;
  private lifecycle: BundleLifecycleManager;
  private placementRegistry: PlacementRegistry;
  private telemetryManager: TelemetryManager;
  private _features: ResolvedFeatures;
  private _internalToken: string;
  private _instanceConfig: InstanceConfig | null;
  private _userStore: UserStore;
  private _workspaceStore: WorkspaceStore;
  private _permissionStore: PermissionStore | null = null;
  private _registryStore: RegistryStore | null = null;
  private _identityProvider: IdentityProvider | null;
  /** Getter for the current request identity — reads from AsyncLocalStorage. */
  _getIdentity: () => UserIdentity | null = () => null;
  /** Getter for the current request workspace ID — reads from AsyncLocalStorage. */
  _getWorkspaceId: () => string | null = () => null;
  /** Per-workspace ToolRegistry instances — each workspace gets its own scoped registry. */
  private _workspaceRegistries: Map<string, ToolRegistry>;
  // Protected sources are captured in start() and passed to startWorkspaceBundles directly.
  /** The system source ("nb") — shared across workspace registries. */
  _systemSource: ToolSource | null;
  /**
   * All platform sources (home, conversations, files, etc.). The WHOLE set —
   * used for placements, identity-source resolution (`getIdentitySource`), and
   * listing identity tools. NOT what workspace registries get; see
   * `_workspaceSources`.
   */
  private _platformSources: ToolSource[] = [];
  /**
   * Platform sources MINUS the kernel identity sources (conversations, …).
   * This is what workspace registries are composed from, so an identity source
   * is unreachable through the workspace door — a `ws_<id>-conversations` name
   * fails closed because the source genuinely isn't in the registry. Identity
   * sources reach the user only through the identity door.
   */
  private _workspaceSources: ToolSource[] = [];
  /**
   * Domain-context getter for the automations bundle. Set by the
   * automations source factory; consumed by internal callers (the
   * automations tool handlers and bundle lifecycle's
   * `installBundleSchedules` / `removeBundleAutomations`) that need the
   * full domain shape — including operator-only fields (`source`,
   * `bundleName`, `allowedTools`) — that the LLM-facing tool schema
   * deliberately doesn't expose. See `src/tools/platform/CLAUDE.md` § 1.4.
   */
  private _automationsContextGetter: (() => AutomationDomainContext) | null = null;
  /**
   * Per-workspace host-resources deps factory. Set in `Runtime.start()`
   * after the resolver + rate-limit are constructed; consumed by every
   * install path that spawns a bundle (lifecycle.installNamed/Local/
   * Remote, connector-tools install, workspace-runtime boot reload).
   * Returns `undefined` only when the
   * runtime is constructed without the host-resources subsystem wired
   * — never in production.
   */
  private _bundleMcpDepsFactory: ((wsId: string) => BundleMcpDeps) | null = null;
  /** Getter for current workspace ID (set per-request). */
  private _currentWorkspaceId: (() => string | null) | null = null;
  /**
   * Cache for `skill://<bundle>/usage` resource fetches. A `null` body is a
   * sentinel meaning "this bundle does not publish the resource" — without it,
   * `loadBundleSkills` would re-probe every non-skill bundle on every chat.
   */
  private skillResourceCache = new Map<string, { content: string | null; fetchedAt: number }>();
  private static readonly SKILL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  /**
   * Conversation IDs with an in-flight chat() call. Prevents concurrent runs on
   * the same conversation.
   *
   * Scope: single-process / single-pod. Correct today because each tenant runs
   * with `platform.replicas: 1` — all chat traffic for a conversation lands on
   * the same Runtime instance. If a tenant is ever scaled to multiple replicas,
   * this lock stops being authoritative (concurrent requests can land on
   * different pods) and this invariant needs to move to a shared store. The
   * conversation JSONL on the shared PVC has the same single-writer assumption,
   * so the two would need to be addressed together.
   */
  private readonly activeConversations = new Set<string>();

  /**
   * Server-authoritative, replayable log of in-flight turns. Detached web
   * chats run through {@link startTurn}; their engine events are published
   * here so any viewer (live, reconnecting, or cross-tab) can replay + tail.
   * The turn's cancellation lives here too — client disconnect does NOT abort.
   */
  private readonly runBus = new RunBus();

  private constructor(
    resolveModelFn: (modelString: string) => LanguageModelV3,
    store: ConversationStore,
    skillMatcher: SkillMatcher,
    config: RuntimeConfig,
    contextSkills: Skill[],
    eventStore: EventSourcedConversationStore | null,
    hooks: EngineHooks,
    defaultEvents: EventSink,
    lifecycle: BundleLifecycleManager,
    placementRegistry: PlacementRegistry,
    telemetryManager: TelemetryManager,
    features: ResolvedFeatures,
    internalToken: string,
    instanceConfig: InstanceConfig | null,
    userStore: UserStore,
    workspaceStore: WorkspaceStore,
    identityProvider: IdentityProvider | null,
    workspaceRegistries: Map<string, ToolRegistry>,
    systemSource: ToolSource | null,
    currentWorkspaceId: () => string | null,
  ) {
    this.resolveModelFn = resolveModelFn;
    this.store = store;
    this.skillMatcher = skillMatcher;
    this.config = config;
    this.contextSkills = contextSkills;
    this.eventStore = eventStore;
    this.hooks = hooks;
    this.defaultEvents = defaultEvents;
    this.lifecycle = lifecycle;
    this.placementRegistry = placementRegistry;
    this.telemetryManager = telemetryManager;
    this._features = features;
    this._internalToken = internalToken;
    this._instanceConfig = instanceConfig;
    this._userStore = userStore;
    this._workspaceStore = workspaceStore;
    // A workspace archive-delete moves its `conversations/` subtree out from
    // under the locator without going through a room store, so the cache would
    // otherwise keep ghosts (and a resume could re-mkdir the archived room).
    // Deletion fires `membershipChanged` for each former member; ride that to
    // invalidate the conversation caches.
    this._workspaceStore.onMembershipChanged(() => this.notifyConversationsChanged());
    this._identityProvider = identityProvider;
    this._workspaceRegistries = workspaceRegistries;
    this._systemSource = systemSource;
    this._currentWorkspaceId = currentWorkspaceId;
  }

  /** Create and start a runtime from config. */
  static async start(config: RuntimeConfig): Promise<Runtime> {
    // Register built-in transport credential providers (e.g. `minted`) at the
    // ONE composition root every entry point shares — serve, the no-subcommand
    // TUI/headless boot, and the automation runner all reach here before
    // startWorkspaceBundles. Idempotent (last-writer-wins); doing it here instead
    // of per-entry-point avoids a provider-auth source failing to boot under any
    // path that forgot to register.
    registerBuiltinCredentialProviders();

    // Derive the override-file path when the caller supplied a configPath
    // but not an explicit override path. The CLI's loadConfig already
    // populates both; this fallback covers embedded callers (tests,
    // library use) that build a RuntimeConfig directly.
    if (config.configPath && !config.configOverridePath) {
      config = { ...config, configOverridePath: deriveOverridePath(config.configPath) };
    }

    const resolveModelFn = resolveModel(config);

    const telemetryManager = TelemetryManager.create({
      workDir: resolveWorkDir(config),
      enabled: config.telemetry?.enabled,
    });

    // Load identity stores early — before bundle startup
    const workDir = resolveWorkDir(config);
    const instanceConfig = await loadInstanceConfig(workDir);
    const userStore = new UserStore(workDir);
    const workspaceStore = new WorkspaceStore(workDir);
    const identityProvider = createIdentityProvider(instanceConfig, userStore, workspaceStore);

    const { events: baseEvents, eventStore } = buildEventSink(config);

    // Create delegate tracker and include it in the event pipeline
    const delegateTracker = new DelegateTracker();
    // Always-on, observe-only Prometheus counters. Process-local: increments in
    // memory whether or not `/metrics` is scraped, so it's safe in a local
    // `bun run dev` with no Prometheus/k8s.
    const sinkList: EventSink[] = [baseEvents, delegateTracker, new MetricsEventSink()];
    if (eventStore) {
      sinkList.push(eventStore);
    }
    if (telemetryManager.isEnabled()) {
      sinkList.push(new PostHogEventSink(telemetryManager));
    }
    const events: EventSink = new MultiEventSink(sinkList);

    // Mint the scoped internal-API auth token (the internal-API bearer checked
    // in auth-middleware). Rotated on every runtime restart — never persisted.
    const internalToken = crypto.randomUUID();

    initWorkDir(config);

    // Create placement registry and lifecycle manager
    const placementRegistry = new PlacementRegistry();
    const mpakHome = join(resolve(resolveWorkDir(config)), "apps");
    const lifecycle = new BundleLifecycleManager(
      events,
      config.configPath,
      config.allowInsecureRemotes,
      mpakHome,
    );
    lifecycle.setPlacementRegistry(placementRegistry);
    // Connector-skill cleanup on uninstall resolves the `connector-skills/`
    // store from this same workDir that install + the per-turn loader use, so
    // an operator `workDir` in nimblebrain.json (NB_WORK_DIR unset) cleans up
    // correctly rather than looking under ~/.nimblebrain.
    lifecycle.setWorkDir(resolveWorkDir(config));

    // Host-resources subsystem. One resolver + one rate-limit shared
    // across every bundle spawned through this runtime, parameterized
    // per-call by workspace id. Construction lives here (not inside
    // lifecycle) because the resolver depends on the workspace-scoped
    // data layout, which is a Runtime concern; lifecycle consumes via
    // `setBundleMcpDepsFactory`, other install paths consume via
    // `Runtime.getBundleMcpDeps(wsId)`.
    const hostResourcesWorkDir = resolveWorkDir(config);
    // Files are identity-owned (Phase B): a bundle's `files://` read/list
    // resolves against the SESSION USER's store (`users/{userId}/files/`), not
    // the workspace the bundle runs in. The resolver fires inside the request
    // context the orchestrator set up for the bundle's tool call, so the
    // identity is in scope here; we resolve it with the same rule `chat()` uses
    // (`resolveRequestOwnerId`) so reads see exactly the files the agent does.
    // Memoize per user — FileStore is cheap closures today, but per-call
    // construction would leak if it ever gains state (fd handles, watchers).
    const hostResourcesFileStoreCache = new Map<string, ReturnType<typeof createFileStore>>();
    const hostResourcesResolver = new FileBackedHostResourcesResolver(() => {
      const userId = resolveRequestOwnerId(
        getRequestContext()?.identity,
        identityProvider !== null,
      );
      const cached = hostResourcesFileStoreCache.get(userId);
      if (cached) return cached;
      const idCtx = new IdentityContext({ userId, workDir: hostResourcesWorkDir });
      const store = createFileStore(idCtx.getDataPath("files"));
      hostResourcesFileStoreCache.set(userId, store);
      return store;
    });
    const hostResourcesRateLimit = new TokenBucketRateLimit();
    const bundleMcpDepsFactory = (wsId: string) => ({
      workspaceId: wsId,
      hostResources: hostResourcesResolver,
      rateLimit: hostResourcesRateLimit,
    });
    lifecycle.setBundleMcpDepsFactory(bundleMcpDepsFactory);

    // Wire the connection-running notification path so URL bundles
    // whose interactive OAuth completes (after the user clicks Connect
    // and returns from the AS) transition out of `pending_auth` and
    // emit the `connection.state_changed` SSE event for the UI.
    setConnectionRunningHandler((wsId, serverName) => {
      lifecycle.recordConnectionStateChange(serverName, wsId, "_workspace", "running");
    });

    const gate = config.confirmationGate ?? new NoopConfirmationGate();

    // Neither `maxInputTokens` nor `maxHistoryMessages` are composed at
    // runtime startup anymore — they're read per-call from `this.config`
    // in `chat()`. The per-call message budget comes from the resolved
    // model's context window minus the static per-call overhead (system
    // prompt + tools + reserved output + safety margin), capped by the
    // operator's `config.maxInputTokens`. See `resolve-message-budget.ts`.
    // The runtime-level hooks below carry only `beforeToolCall`;
    // `transformContext` is built per-request so the budget reflects
    // what the model actually sees on each call.

    // Build delegate context for nb__delegate tool
    // Use a late-bound getter for defaultModel so it reflects live config changes
    const getDefaultModel = () => {
      const models = config.models;
      return models?.default ?? config.defaultModel ?? DEFAULT_MODEL;
    };
    const resolveSlot = (s: string): string => {
      const slot = parseAliasRef(s);
      if (!slot) return s;
      const models = config.models;
      const fallback = config.defaultModel ?? DEFAULT_MODEL;
      const slots: ModelSlots = {
        default: models?.default ?? fallback,
        fast: models?.fast ?? fallback,
        reasoning: models?.reasoning ?? fallback,
      };
      return slots[slot];
    };
    const delegateCtx: DelegateContext = {
      resolveModel: resolveModelFn,
      resolveSlot,
      // Child engine's per-call ToolRouter.
      //
      // Identity-bound when both an authenticated identity AND a workspace are
      // in the request context (the chat / `/mcp` path): the child is walled to
      // the SAME one workspace as the parent, exactly like the parent's router.
      // It reaches that workspace's tools plus the caller's identity tools —
      // never another workspace; `routeToolCall` denies any cross-workspace
      // dispatch. (See `IdentityToolRouter`.)
      //
      // Falls back to the current workspace's registry when no identity or no
      // workspace is in scope — CLI / dev paths construct delegateCtx without an
      // authenticated identity, and the workspace registry's bare-name surface
      // is what they expect.
      //
      // The child's INITIAL active set is governed by `defaultActiveTools`
      // below, not by this router.
      get tools() {
        if (!rtHolder.rt) throw new Error("Runtime not initialized");
        const identity = getRequestContext()?.identity;
        const wsId = rtHolder.rt._currentWorkspaceId?.();
        // Build the identity-bound router only when both an identity and a
        // workspace are in scope; otherwise (CLI / dev) the bare workspace
        // registry is what the caller expects.
        if (!identity || !wsId) return rtHolder.rt.getRegistryForCurrentWorkspace();
        return new IdentityToolRouter({
          identityId: identity.id,
          workspaceId: wsId,
          runtime: rtHolder.rt,
        });
      },
      // Default initial active set: focused-workspace tools (namespaced
      // so the identity router can route them) + bare kernel identity
      // tools. Mirrors `_chatInner`'s `allTools` composition so a child
      // agent starts with the same default tool view the parent has.
      // Bare-name globs in `tools: [...]` match against THIS set; namespaced
      // globs match the bound workspace's reachable set — see
      // `DelegateContext.tools`.
      defaultActiveTools: async (): Promise<ToolSchema[]> => {
        if (!rtHolder.rt) throw new Error("Runtime not initialized");
        const rt = rtHolder.rt;
        const wsId = rt._currentWorkspaceId?.();
        const orgRole = getRequestContext()?.identity?.orgRole;
        if (!wsId) {
          // Dev / CLI path without a workspace in scope — return identity
          // tools only. Hard-failing here would break the existing CLI
          // delegate path, which currently delegates without any workspace
          // context. The workspace door simply contributes nothing.
          const identityTools = await rt.listIdentitySourceTools();
          return identityTools
            .filter((t) => isToolVisibleToRole(t.name, orgRole))
            .map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
            }));
        }
        const registry = rt.getRegistryForWorkspace(wsId);
        const [focusedTools, identityTools] = await Promise.all([
          registry.availableTools(),
          rt.listIdentitySourceTools(),
        ]);
        return [
          ...focusedTools
            .filter((t) => isToolVisibleToRole(t.name, orgRole))
            .map((t) => ({
              name: namespacedToolName(wsId, t.name),
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
            })),
          ...identityTools
            .filter((t) => isToolVisibleToRole(t.name, orgRole))
            .map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
            })),
        ];
      },
      events,
      // Use getter so workspace agents override instance agents per-request.
      // Workspace agents merge over (not replace) instance agents.
      // Prefers AsyncLocalStorage context for concurrency safety.
      get agents() {
        const scope = getRequestContext()?.scope;
        const wsAgents = scope?.kind === "workspace" ? scope.workspaceAgents : null;
        if (wsAgents) {
          return { ...(config.agents ?? {}), ...wsAgents };
        }
        return config.agents;
      },
      getRemainingIterations: () => delegateTracker.getRemainingIterations(),
      getParentRunId: () => delegateTracker.getParentRunId(),
      defaultModel: getDefaultModel(),
      defaultMaxInputTokens: config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      // Raw operator config (may be undefined). Delegate resolves against
      // the child's model at execution time so the resolved values fit
      // the child's model rather than the parent's.
      configMaxOutputTokens: config.maxOutputTokens,
      configThinking: config.thinking,
      configThinkingBudgetTokens: config.thinkingBudgetTokens,
      // Per-engine isolation for tool promotion: child engines get their
      // own controls installed in reqCtx (with save/restore) instead of
      // inheriting the parent's via AsyncLocalStorage.
      get toolPromotion() {
        if (!rtHolder.rt) return undefined;
        return rtHolder.rt.buildToolPromotionFactory();
      },
    };

    // System tools (search, status, delegate). Skill mutation lives in the
    // dedicated `nb__skills` source — registered separately via
    // `createPlatformSources`.
    // Use a late-bound holder so reloadSkills can reference `rt` after construction.
    const rtHolder: { rt?: Runtime } = {};
    const boundReloadSkills = async () => {
      if (rtHolder.rt) await rtHolder.rt.reloadSkills();
    };
    const skillDirPath = globalSkillDir(config);
    const boundGetSkills = () => {
      const rt = rtHolder.rt;
      return {
        context: rt ? rt.getContextSkills() : [],
        matchable: rt ? rt.getMatchableSkills() : [],
      };
    };
    const features = resolveFeatures(config.features);
    const hooks: EngineHooks = {
      beforeToolCall: createPrivilegeHook(gate, events, features),
      // `transformContext` is intentionally NOT set here. It is composed
      // per-request in `chat()` because the message budget depends on
      // values only known at call time (the resolved model's context
      // window, the per-call system prompt and tool set, and the
      // resolved `maxOutputTokens`). See `resolveMessageBudget`.
    };

    const store = buildStore(config);
    const { contextSkills, skillMatcher } = buildSkills(config);

    // Request-scoped context — all identity/workspace reads go through AsyncLocalStorage.
    // Set via runWithRequestContext() in chat(), handleToolCall(), and MCP handler.
    const getIdentity = (): UserIdentity | null => getRequestContext()?.identity ?? null;
    const getWorkspaceId = (): string | null => {
      const scope = getRequestContext()?.scope;
      return scope?.kind === "workspace" ? scope.workspaceId : null;
    };

    // Build management tool contexts using the identity holder + stores from task 001
    // ManageUsersContext is always created. In dev mode (no identity provider),
    // the tool can still list/update/delete users — it just can't create
    // users with API keys (that requires a provider with credential login).
    const manageUsersCtx = { getIdentity, userStore, provider: identityProvider };
    const manageWorkspacesCtx = { getIdentity, workspaceStore };
    const manageMembersCtx = { getIdentity, workspaceStore, userStore };
    const noActiveToolPromotionRun = (toolName: string): ToolPromotionResult => ({
      ok: false,
      toolName,
      changed: false,
      reason: "no_active_run",
      message: "Tool promotion tools can only be called during an active agent run.",
    });
    const toolPromotionCtx = {
      addTool: (toolName: string) =>
        getRequestContext()?.toolPromotion?.addTool(toolName) ?? noActiveToolPromotionRun(toolName),
      removeTool: (toolName: string) =>
        getRequestContext()?.toolPromotion?.removeTool(toolName) ??
        noActiveToolPromotionRun(toolName),
    };
    const isToolEligibleForCurrentRequest = (tool: ToolSchema): boolean => {
      const ctx = getRequestContext();
      return isToolEligibleForPromotion(tool, ctx?.identity?.orgRole, features);
    };
    const toolEligibilityCtx = { isToolEligible: isToolEligibleForCurrentRequest };

    // Create Runtime with empty workspace registries first — needed by system tools
    const rt = new Runtime(
      resolveModelFn,
      store,
      skillMatcher,
      config,
      contextSkills,
      eventStore,
      hooks,
      events,
      lifecycle,
      placementRegistry,
      telemetryManager,
      features,
      internalToken,
      instanceConfig,
      userStore,
      workspaceStore,
      identityProvider,
      new Map<string, ToolRegistry>(),
      null, // systemSource — set after creation
      getWorkspaceId,
    );
    rtHolder.rt = rt;
    rt._getIdentity = getIdentity;
    rt._getWorkspaceId = getWorkspaceId;

    // Register the `nb` system source. Built as an in-process MCP server
    // — `createSystemTools` returns it already-started so it's ready to
    // serve tools and resources to every workspace registry.
    const systemTools = await createSystemTools(
      () => rt.getRegistryForCurrentWorkspace(),
      config.configPath,
      gate,
      lifecycle,
      delegateCtx,
      skillDirPath,
      boundReloadSkills,
      boundGetSkills,
      events,
      features,
      rt,
      undefined, // reserved slot — was mpakHome (legacy searchBundles path, removed)
      manageUsersCtx,
      manageWorkspacesCtx,
      manageMembersCtx,
      undefined, // reserved slot — was manageBundleCtx (nb__manage_app, removed)
      toolPromotionCtx,
      toolEligibilityCtx,
    );
    rt._systemSource = systemTools;

    // Phase 2: Create platform capability sources. Each is an in-process
    // MCP server reachable through `InMemoryTransport` — no subprocess.
    // `createPlatformSources` returns sources already started.
    //
    // The automations source registers its domain-context getter on `rt`
    // during construction (rt.registerAutomationsContext). We forward the
    // getter to the lifecycle manager so bundle-contributed schedules
    // can be created/removed via the domain API directly — bypassing the
    // LLM-facing tool surface (which doesn't accept `source: "bundle"`
    // or `bundleName`). See src/tools/platform/CLAUDE.md § 1.4.
    const { createPlatformSources } = await import("../tools/platform/index.ts");
    const platformSources = await createPlatformSources(rt, events);
    if (rt._automationsContextGetter) {
      lifecycle.setAutomationsContextGetter(rt._automationsContextGetter);
    }
    // Make the host-resources factory accessible on `rt` so non-lifecycle
    // install paths (connector-tools, boot reload) can pull deps directly.
    rt._bundleMcpDepsFactory = bundleMcpDepsFactory;

    // Register placements declared by platform sources. The helper isolates
    // the duck-type — `getPlacements()` is on `McpSource` (carrying the
    // declarations from `defineInProcessApp`) but isn't on the `ToolSource`
    // interface itself.
    for (const src of platformSources) {
      const placements = readSourcePlacements(src);
      if (placements.length > 0) {
        placementRegistry.register(src.name, placements);
      }
    }

    // Partition: workspace registries get every platform source EXCEPT the
    // kernel identity sources (conversations, …). Identity sources stay in
    // `_platformSources` (already started by `createPlatformSources`) and reach
    // the user only through the identity door — never `ws_<id>-conversations`.
    const workspaceSources = platformSources.filter((s) => !isIdentitySource(s.name));

    // Phase 3: Start workspace bundles with per-workspace registries
    const configDir = config.configPath ? dirname(config.configPath) : undefined;
    const { registries: workspaceRegistries, entries: workspaceBundleEntries } =
      await startWorkspaceBundles(
        workspaceStore,
        workspaceSources,
        systemTools,
        events,
        configDir,
        {
          workDir: resolveWorkDir(config),
          allowInsecureRemotes: config.allowInsecureRemotes,
          // Boot re-spawn picks up host-resources handlers per workspace so
          // a platform restart doesn't silently drop the capability for
          // already-installed bundles.
          getBundleMcpDeps: bundleMcpDepsFactory,
          // Late-bound: a boot-started connection that loses auth mid-session
          // fires this on a post-boot tool call, by which point `rt.lifecycle`
          // is constructed. Flip the Connection to reauth_required so the UI
          // offers "Reconnect" instead of every call failing silently.
          onAuthLost: (wsId, serverName) => {
            rt.lifecycle?.recordConnectionStateChange(
              serverName,
              wsId,
              "_workspace",
              "reauth_required",
            );
          },
        },
      );
    rt._workspaceRegistries = workspaceRegistries;
    rt._platformSources = platformSources;
    rt._workspaceSources = workspaceSources;

    // Wire the workspace registries into lifecycle so workspace-scope
    // startAuth / disconnect / install can add+remove sources without
    // each route having to thread the registry through.
    lifecycle.setWorkspaceRegistries(workspaceRegistries);

    // Seed lifecycle instances for workspace bundles. Operators are
    // expected to have run `bun run migrate:user-creds` (T003) before
    // deploying Stage 2 — see
    // the Stage 2 deploy runbook. The
    // runtime no longer migrates or normalizes legacy `oauthScope: "user"`
    // records at boot; a legacy ref reaches `seedInstance` only via
    // `buildProcessInventory` and throws `LegacyOAuthScopeError` there.
    for (const entry of workspaceBundleEntries) {
      const { serverName: sn, bundle: ref, meta, wsId, dataDir } = entry;
      const label = "name" in ref ? ref.name : "url" in ref ? ref.url : ref.path;
      const wsRegistry = workspaceRegistries.get(wsId);
      lifecycle.seedInstance(sn, label, ref, meta ?? undefined, wsId, dataDir, wsRegistry);

      const instance = lifecycle.getInstance(sn, wsId);
      if (instance?.ui?.placements && instance.ui.placements.length > 0) {
        // Sanitize at boot too — not just at install. Placements persist RAW on
        // the BundleRef (`instance.ui` is the unfiltered host meta), so a spoof
        // that `registerPlacements` dropped at install time would otherwise
        // re-register verbatim here on every restart. Same fail-closed guard.
        const safe = sanitizePlacements(instance.ui.placements);
        if (safe.length > 0) placementRegistry.register(sn, safe, wsId);
      }
    }

    // Boot-time visibility: the locked curated registry is the platform's
    // non-empty-Browse guarantee. Warn loudly if its resolved catalog
    // path yields zero entries (missing/empty mount, mis-set
    // NB_CURATED_CATALOG_DIR) so an empty Browse is diagnosable rather
    // than silent.
    await warnIfCuratedCatalogEmpty(rt.getRegistryStore());

    return rt;
  }

  /** True if a chat() is currently in flight on this conversation. */
  isConversationActive(conversationId: string): boolean {
    return this.activeConversations.has(conversationId);
  }

  /** Process a chat message. Optional per-request EventSink for SSE streaming. */
  async chat(request: ChatRequest, requestSink?: EventSink): Promise<ChatResult> {
    const lockedConvId = request.conversationId;
    if (lockedConvId && this.activeConversations.has(lockedConvId)) {
      throw new RunInProgressError(lockedConvId);
    }
    if (lockedConvId) this.activeConversations.add(lockedConvId);
    try {
      return await this._chatInner(request, requestSink);
    } finally {
      if (lockedConvId) this.activeConversations.delete(lockedConvId);
    }
  }

  // ===========================================================================
  // Detached, server-authoritative turns (conversation-tab rewrite).
  //
  // `startTurn` runs a chat turn to completion regardless of the caller's
  // connection. The conversation id is resolved up front and returned
  // immediately; the engine run continues in the background, publishing every
  // event to the RunBus. Clients are viewers — they replay buffered events via
  // `getTurnReplay` then tail live ones via the `onTurnEvent` SSE fan-out.
  // Client disconnect does NOT abort; only `cancelTurn` (Stop) does.
  // ===========================================================================

  /** Whether a detached turn is currently generating for this conversation. */
  isTurnActive(conversationId: string): boolean {
    return this.runBus.isActive(conversationId);
  }

  /** Highest event sequence number for a conversation's current/last run. */
  turnSeq(conversationId: string): number {
    return this.runBus.currentSeq(conversationId);
  }

  /** Explicitly cancel an in-flight turn (the Stop button). */
  cancelTurn(conversationId: string): boolean {
    if (!this.runBus.isActive(conversationId)) return false;
    // Publish the terminal `cancelled` frame to live viewers BEFORE ending the
    // run. `RunBus.cancel` flips status to terminal synchronously, after which
    // `publish` is a no-op — so the engine's own post-abort `cancelled` publish
    // (in startTurn's catch) never reaches the SSE. Without this, the Stop
    // button aborts generation but the UI stays stuck streaming until a reload.
    this.publishTurnEvent(conversationId, "cancelled", {});
    return this.runBus.cancel(conversationId);
  }

  /**
   * Start a chat turn that runs to completion server-side, decoupled from the
   * caller's connection. Resolves (creating if new) the conversation id up
   * front, reserves the run on the RunBus, then runs the engine in the
   * background — publishing every event to the bus so viewers can replay via
   * {@link getTurnReplay} and tail via the `onTurnEvent` fan-out. Returns once
   * the id is known; the turn keeps
   * running after the HTTP request that called this returns. Throws
   * {@link RunInProgressError} if a turn is already active for the conversation.
   */
  async startTurn(request: ChatRequest): Promise<{ conversationId: string }> {
    // Same strict production-vs-dev owner rule as `chat()` and the REST
    // handlers — one shared resolver, no forked copy to drift out of sync.
    const ownerId = resolveRequestOwnerId(request.identity, this._identityProvider !== null);
    // `workspaceId` is the FOCUSED workspace (the `/w/:slug` the user is
    // viewing), optional — exactly as the sync `chat()` path treats it. On a
    // home / identity route there's no focus, so the turn is identity-level;
    // fall back to the caller's personal workspace for the conversation
    // metadata breadcrumb, matching `chat()`'s `sessionWsId` resolution. This
    // is delegated to `chat()` below, which re-resolves the same fallback for
    // tool scope. (Pre-Stage-2 this hard-threw; that surfaced as a raw 500 on
    // a legitimate workspaceless chat-start.)
    const wsId = request.workspaceId ?? personalWorkspaceIdFor(ownerId);
    const createOpts: CreateConversationOptions = {
      ownerId,
      workspaceId: wsId,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    // Resolve the conversation's room store: the conversation's own room on
    // resume (authoritative, from the locator), or the room it's born in
    // (`wsId`) for a new conversation. The room owns the directory.
    const { store } = await this.resolveChatStore(request.conversationId, wsId, ownerId);

    // Reserve the run (throws RunInProgressError if one is already active). The
    // returned signal is the RunBus's — NOT the HTTP request's — so a client
    // disconnect won't abort generation.
    //
    // For a provided id: authorize, THEN reserve the run. Ownership is checked
    // before `begin` mutates shared run state — an unauthorized caller never
    // flips `isActive`. There is no `await` between the load+ownership check and
    // `begin` (the check is synchronous), so nothing can create the conversation
    // in that gap; `begin` is still the serialization point for `create` (a
    // concurrent same-id start throws `RunInProgressError` at `begin` before it
    // can reach the truncating write). On a create failure we `evict` OUR
    // reservation — passing the signal `begin` returned so that if the create
    // await let a cancel + a fresh same-id `begin` slip in, we don't evict that
    // newer live run. A fresh conversation has no id until create(), so that
    // path begins after.
    const isNew = !request.conversationId;
    let conversationId: string;
    let signal: AbortSignal;
    if (request.conversationId) {
      const existing = await store.load(request.conversationId);
      if (existing && existing.ownerId !== ownerId) {
        throw new ConversationAccessDeniedError(request.conversationId, ownerId);
      }
      signal = this.runBus.begin(request.conversationId);
      try {
        conversationId =
          existing?.id ?? (await store.create({ ...createOpts, id: request.conversationId })).id;
      } catch (err) {
        this.runBus.evict(request.conversationId, signal);
        throw err;
      }
    } else {
      conversationId = (await store.create(createOpts)).id;
      signal = this.runBus.begin(conversationId);
    }

    // Seed the run stream with the user's message so the turn is
    // self-contained: any viewer (sender, other tab, post-refresh) can
    // reconstruct user + assistant from replay alone, no optimistic client
    // state required.
    this.publishTurnEvent(conversationId, "user.message", {
      content: request.message,
      ...(ownerId ? { userId: ownerId } : {}),
      timestamp: new Date().toISOString(),
    });

    // Tell conversation-list UIs a new conversation exists (so the row + its
    // streaming dot appear immediately). Resolved-existing turns already have
    // a row.
    if (isNew) this.emitConversationsChanged();

    const busSink = this.createRunBusSink(conversationId);
    // Detached: run to completion regardless of the caller's connection.
    void this.chat({ ...request, conversationId, signal }, busSink)
      .then((result) => {
        // Publish a terminal `done` carrying the final result so viewers
        // finalize the assistant message, then close the run.
        this.publishTurnEvent(conversationId, "done", {
          response: result.response,
          conversationId: result.conversationId,
          toolCalls: result.toolCalls,
          stopReason: result.stopReason,
          usage: result.usage,
        });
        this.runBus.end(conversationId, "done");
      })
      .catch((err) => {
        if (signal.aborted) {
          this.publishTurnEvent(conversationId, "cancelled", {});
          this.runBus.end(conversationId, "cancelled");
        } else {
          this.publishTurnEvent(conversationId, "error", {
            error: "engine_error",
            message: err instanceof Error ? err.message : String(err),
          });
          this.runBus.end(conversationId, "error");
        }
      })
      .finally(() => {
        // Refresh list UIs so the row's dot clears and the final title shows.
        this.emitConversationsChanged();
      });

    return { conversationId };
  }

  /**
   * Live fan-out hook for detached-turn events. The API layer sets this to
   * forward each published event to the per-conversation SSE manager so
   * connected viewers tail in real time. Buffering/replay stays in the RunBus;
   * this is purely the live edge.
   */
  onTurnEvent?: (conversationId: string, event: BufferedRunEvent) => void;

  /** Replay snapshot of an in-flight turn for a newly connecting viewer. */
  getTurnReplay(conversationId: string, afterSeq: number): BufferedRunEvent[] {
    return this.runBus.bufferedSince(conversationId, afterSeq);
  }

  /** Publish to the RunBus (buffer/replay) and fan out live (SSE viewers). */
  private publishTurnEvent(conversationId: string, type: string, data: unknown): void {
    const buffered = this.runBus.publish(conversationId, type, data);
    if (buffered) this.onTurnEvent?.(conversationId, buffered);
  }

  /** EventSink that forwards engine events into the RunBus for one turn. */
  private createRunBusSink(conversationId: string): EventSink {
    return {
      emit: (event: EngineEvent) => {
        this.publishTurnEvent(conversationId, event.type, event.data);
      },
    };
  }

  /** Broadcast a conversations-list change on the global sink (→ SSE → iframe). */
  private emitConversationsChanged(): void {
    this.defaultEvents.emit({
      type: "data.changed",
      data: { server: "conversations", tool: "list" },
    });
  }

  private async _chatInner(request: ChatRequest, requestSink?: EventSink): Promise<ChatResult> {
    // Identity-bound chat session, walled to one workspace.
    //
    // The chat surface has no session-level `workspaceId` field; the focused
    // workspace arrives per request (`request.workspaceId`). Tool reach is
    // exactly that one workspace's tools plus the caller's identity tools —
    // never a cross-workspace union — and each tool call routes via the
    // orchestrator, which denies any other workspace. Single-workspace reads
    // (focused app, overlays, skills) bind to the focused workspace; the file
    // store and other session-bridge reads use the identity's personal
    // workspace (`sessionWsId`).
    //
    // Identity resolution rules (strict, no `??` fallbacks anywhere):
    //   - When an identity provider is configured (production / `instance.json`):
    //     `request.identity` MUST be set. Throw otherwise — auth middleware
    //     populates this field; absence means a misconfigured deployment.
    //   - When no identity provider is configured (dev mode / tests / CLI):
    //     fall back to `DEV_IDENTITY` (`usr_default`). The fallback is
    //     gated on `!this._identityProvider` so the same path can't
    //     silently degrade production into "owned by usr_default."
    //
    // Note: `_chatInner` performs the identity check BEFORE any IO so a
    // bad-state call rejects synchronously (acceptance criterion: identity
    // required).
    // Owner resolution is the shared identity rule (production requires an
    // identity; dev falls back to DEV_IDENTITY) — see `resolveRequestOwnerId`.
    // The same rule resolves files for the REST upload/serve handlers and the
    // host-resources resolver, so an upload and its rehydration share a store.
    const ownerId = resolveRequestOwnerId(request.identity, this._identityProvider !== null);
    const requestIdentity = request.identity ?? DEV_IDENTITY;

    // The personal workspace is the identity-bound chat's "session
    // workspace" — used for overlays, file storage, app-skill reads, and
    // the workspace-agents / workspace-models override lookup. Per-tool
    // dispatch goes through the orchestrator's parsed-namespace path and
    // does NOT read this value (acceptance criterion: every tool's
    // WorkspaceContext is built from the parsed namespace, not from
    // ChatRequest / conversation metadata).
    const sessionWsId = personalWorkspaceIdFor(requestIdentity.id);
    // Ensure the personal workspace exists + has a registry. The normal
    // login path (`ensureUserWorkspace`) already provisions; this is the
    // belt-and-suspenders for embedded / dev callers / CLI flows that
    // never went through HTTP auth. `ensureUserWorkspace` is idempotent
    // — fast read-path on the warm case (the store hit is cached) and
    // self-heals any drift, matching production's login posture so the
    // same code path serves both surfaces.
    await ensureUserWorkspace(this._workspaceStore, {
      id: requestIdentity.id,
      ...(requestIdentity.displayName ? { displayName: requestIdentity.displayName } : {}),
    });
    await this.ensureWorkspaceRegistry(sessionWsId);

    // The conversation's ROOM — the binding. A chat is born in the focused
    // workspace, or the caller's personal room when there's no focus
    // (`request.workspaceId ?? sessionWsId`), and stays there for its whole
    // life. On resume the room is read from the conversation's own path via the
    // locator (authoritative). The room owns the directory; the path is the
    // boundary. This is a SEPARATE axis from `toolsWsId` (tool/skill/app scope)
    // below — the conversation room is fixed at create, the tool scope is not.
    const roomWsId = request.workspaceId ?? sessionWsId;
    const { store } = await this.resolveChatStore(request.conversationId, roomWsId, ownerId);

    // Load the personal workspace config for agents / models override.
    // Pre-Stage-2 this looked up the request's `workspaceId`; that field
    // is gone, and "override on the user's own workspace" is the natural
    // identity-bound semantic. Stage 6 may relocate this to a per-
    // conversation pin if multi-workspace overrides become a need.
    const sessionWorkspace = await this._workspaceStore.get(sessionWsId);

    const createOpts: CreateConversationOptions = {
      ownerId,
      // The conversation's room binding — the workspace it's born in (focused,
      // or personal when unfocused). Authoritative: the conversation is stored
      // under `workspaces/<workspaceId>/conversations/<ownerId>/`, and this is
      // fixed for its whole life (no mid-chat room switching).
      workspaceId: roomWsId,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    // Resume an existing conversation only if the caller owns it.
    // Conversations live on a single top-level store (not per-workspace),
    // so this ownerId check is the ONLY barrier between users and each
    // other's conversations — it runs in the load-bearing chat path, not
    // just at a higher layer.
    //
    // The disambiguation between "doesn't exist" (→ create new) and
    // "exists but isn't yours" (→ throw) matters: silently creating a
    // new conversation when the caller passes a foreign id would mask
    // a takeover attempt as a normal flow.
    let conversation: Conversation;
    if (request.conversationId) {
      const existing = await store.load(request.conversationId);
      if (existing && existing.ownerId !== ownerId) {
        throw new ConversationAccessDeniedError(request.conversationId, ownerId);
      }
      conversation = existing ?? (await store.create(createOpts));
    } else {
      conversation = await store.create(createOpts);
    }

    // Preserve metadata on resumed conversations (don't overwrite)
    if (request.metadata && !conversation.metadata) {
      conversation.metadata = request.metadata;
    }

    // Build user message content: text + MCP `resource_link` blocks for
    // attachments. Bytes for binary attachments live in the workspace
    // FileStore (already persisted by `ingestFiles`); the conversation log
    // carries only the URI. The runtime rehydrates image links to AI SDK
    // `file` parts at the `model.doStream` boundary — see `rehydrateUserResources`.
    type TextPart = { type: "text"; text: string };
    type ResourceLinkPart = {
      type: "resource_link";
      uri: string;
      mimeType: string;
      name: string;
    };
    const userContent: Array<TextPart | ResourceLinkPart> = [];
    if (request.message) {
      userContent.push({ type: "text", text: request.message });
    }
    if (request.contentParts?.length) {
      for (const part of request.contentParts) {
        if (part.type === "text") {
          userContent.push({ type: "text", text: part.text });
        } else if (part.type === "resource_link") {
          userContent.push({
            type: "resource_link",
            uri: part.uri,
            mimeType: part.mimeType,
            name: part.name,
          });
        }
      }
    }

    // Ensure content is never empty — file-only uploads may have no text message
    if (userContent.length === 0) {
      const filenames = request.fileRefs?.map((f) => f.filename).join(", ") || "files";
      userContent.push({ type: "text", text: `[Uploaded: ${filenames}]` });
    }

    await store.append(conversation, {
      role: "user",
      content: userContent,
      timestamp: new Date().toISOString(),
      ...(request.identity?.id ? { userId: request.identity.id } : {}),
      ...(request.fileRefs?.length ? { metadata: { files: request.fileRefs } } : {}),
    });

    // The workspace the chat is FOCUSED on (the `/w/:slug` being viewed);
    // absent on the home control panel. Hoisted above the per-request skill
    // match below because the conversation pool is keyed on it. Reused
    // unchanged by the briefing / apps / overlay surfaces further down.
    const focusedWsId = request.workspaceId;

    // Per-request trigger/keyword match. The boot-time `this.skillMatcher`
    // only ever scans org-tier dirs (`config.skillDirs` + `globalSkillDir`),
    // never `workspaces/<id>/skills/` or `users/<id>/skills/`, so those tiers
    // could never trigger-match. Build the matcher from the merged
    // conversation pool instead — org + workspace + user, which already folds
    // in the boot matchable + builtin skills (see `loadConversationSkills`) —
    // so the match is a superset of today's plus the workspace/user tiers fire.
    //
    // The pool is computed ONCE here and threaded into `selectRequestLayer3`
    // below so the disk read happens a single time per turn. `userId` is
    // hoisted from its later definition site for this reason; keep it a single
    // definition (the layer-3 call reuses it).
    const userId = requestIdentity.id;
    // Partition the conversation pool by ROLE once: `context` skills (every tier)
    // compose into the always-on Layer 0/1 channel; `capability` skills feed the
    // conditional channels (keyword matcher + tool-affinity Layer 3). Disjoint by
    // `type`, so nothing is injected twice — no downstream de-dup.
    const conversationPool = this.loadConversationSkills(focusedWsId ?? sessionWsId, userId);
    const { context: poolContext, capability: poolCapability } =
      partitionSkillsByRole(conversationPool);
    const requestMatcher = new SkillMatcher();
    requestMatcher.load(poolCapability);
    const skill = requestMatcher.match(request.message);

    // The workspace BRIEFING (apps + workspace overlay + "## Workspace" block
    // + workspace persona) reflects the workspace the chat is FOCUSED on —
    // `focusedWsId` (= `request.workspaceId`, hoisted above). On the home
    // control panel there is NO focus (`request.workspaceId` absent): the chat
    // is identity-level, so the briefing is empty — cross-workspace tools and
    // ORG-level house rules only, no single "current workspace". The personal
    // workspace stays the SILENT session bridge (`sessionWsId`, used for the
    // dispatch reqCtx + file store), never narrated. Deterministic +
    // workspace-scoped when focused (same for every member).
    const apps = focusedWsId ? await this.buildAppsList(focusedWsId) : [];
    // Org overlay always applies (org-level, not workspace-specific); the
    // workspace overlay only when focused.
    const liveOverlays = focusedWsId
      ? await this.readPromptOverlays(focusedWsId)
      : { org: await this.getInstructionsStore().read({ scope: "org" }), workspace: "" };

    // Build focusedApp when the request is scoped to a specific app (§7 app-aware chat).
    // The app is resolved in the SAME single workspace the session's tools are
    // bound to (`focusedWsId ?? sessionWsId` — see `toolsWsId` below), never a
    // scan across the identity's other workspaces. The wall applies to the
    // briefing too: it can only ever describe an app whose tools this session
    // is actually allowed to call.
    let focusedApp: FocusedAppInfo | undefined;
    let focusedAppWsId: string | undefined;
    if (request.appContext) {
      const appWsId = focusedWsId ?? sessionWsId;
      const reg = this._workspaceRegistries.get(appWsId);
      const source = reg?.getSources().find((s) => s.name === request.appContext?.serverName);
      if (source) {
        try {
          const sourceTools = await source.tools();
          const skillResource = await this.getAppSkillResource(request.appContext.serverName);
          const referenceUri = `skill://${request.appContext.serverName}/reference`;
          const hasReference = skillResource
            ? source instanceof McpSource && (await this.hasResource(source, referenceUri))
            : false;
          const bundleInstance = this.lifecycle?.getInstance(
            request.appContext.serverName,
            appWsId,
          );
          focusedApp = {
            name: request.appContext.appName,
            tools: sourceTools.map((t) => ({
              name: t.name,
              description: t.description,
            })),
            ...(skillResource ? { skillResource } : {}),
            ...(hasReference ? { referenceResourceUri: referenceUri } : {}),
            trustScore: bundleInstance?.trustScore ?? 100,
          };
          focusedAppWsId = appWsId;
        } catch {
          // Source stopped or crashed — no app briefing this turn.
        }
      }
    }

    // Build appState for prompt injection (Synapse Feature 2 — LLM-aware UI state).
    let appState: AppStateInfo | undefined;
    if (request.appContext?.appState && focusedApp && focusedAppWsId) {
      const bundleRef = this.lifecycle?.getInstance(request.appContext.serverName, focusedAppWsId);
      appState = {
        state: request.appContext.appState.state,
        summary: request.appContext.appState.summary,
        updatedAt: request.appContext.appState.updatedAt,
        trustScore: bundleRef?.trustScore ?? 100,
      };
    }

    // Tool surfacing. A session reaches exactly ONE workspace: the ACTIVE set
    // the model sees is the FOCUSED workspace's tools (one copy of the platform
    // `nb__*` tools + that workspace's apps) plus the caller's identity tools.
    // There is no cross-workspace union. `nb__search`'s corpus
    // (`listDiscoverableTools`) is this same focused workspace, so progressive
    // disclosure operates WITHIN the room (a workspace with more tools than the
    // active cap), not across workspaces. Role-based visibility
    // (`isToolVisibleToRole`) and surface-tier tiering (`surfaceTools`) apply to
    // this set. At the identity-level home (no focus) the personal workspace is
    // the room — the same silent bridge used for session reads.
    const toolsWsId = focusedWsId ?? sessionWsId;
    const toolsRegistry = await this.ensureWorkspaceRegistry(toolsWsId);
    const [focusedTools, identityTools] = await Promise.all([
      toolsRegistry.availableTools(),
      this.listIdentitySourceTools(),
    ]);
    const allTools: ToolSchema[] = [
      // Workspace tools — namespaced to the focused workspace so the
      // orchestrator routes them; one copy of `nb__*`, not N.
      ...focusedTools
        .filter((t) => isToolVisibleToRole(t.name, requestIdentity.orgRole))
        .map((t) => ({
          name: namespacedToolName(toolsWsId, t.name),
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
        })),
      // Identity tools (conversations, …) — bare, owned by the user.
      ...identityTools
        .filter((t) => isToolVisibleToRole(t.name, requestIdentity.orgRole))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
        })),
    ];
    // Post-aggregator the focused-app match key is the WORKSPACE-PREFIXED
    // source name: tools land in the active list as
    // `ws_<id>-<source>__<tool>`, and `surfaceTools.focusedServerName`
    // matches with `t.name.startsWith(prefix + "__")`. Build via the
    // namespace primitive (single legal construction site for
    // `ws_<id>-<...>` per `check:tool-namespace`).
    const focusedNamespaced =
      request.appContext && focusedAppWsId
        ? namespacedToolName(focusedAppWsId, request.appContext.serverName)
        : undefined;
    const { direct: tools, proxied } = surfaceTools(allTools, skill, {
      ...(focusedNamespaced ? { focusedServerName: focusedNamespaced } : {}),
      ...(request.allowedTools ? { requestAllowedTools: request.allowedTools } : {}),
    });

    // Per-user preferences from the authenticated identity. We already
    // hard-error if no identity above, so reads here are unconditional.
    const prefs = {
      displayName: requestIdentity.displayName ?? "",
      timezone: requestIdentity.preferences?.timezone ?? "",
      locale: requestIdentity.preferences?.locale ?? "en-US",
    };

    // The prompt narrates the FOCUSED workspace — the same one whose apps +
    // house rules the briefing above describes — so the prose, the app list,
    // and the persona all agree. Reuse the already-loaded session workspace
    // when it's the focused one; otherwise load the focused workspace.
    const activeWorkspace = focusedWsId
      ? focusedWsId === sessionWsId
        ? sessionWorkspace
        : await this._workspaceStore.get(focusedWsId)
      : undefined;
    // No focus (home) → undefined → compose omits the "## Workspace" block.
    const workspaceContext = focusedWsId
      ? activeWorkspace
        ? { id: activeWorkspace.id, name: activeWorkspace.name }
        : { id: focusedWsId }
      : undefined;

    // Workspace identity/persona override — follows the focused workspace too.
    const identityOverride = activeWorkspace?.identity
      ? makeIdentitySkill(activeWorkspace.identity)
      : null;
    // Always-on context channel: the `type: context` skills across every tier
    // (core/builtin/org + workspace + user), not just the boot-time set.
    const contextBase = poolContext;
    const requestContextSkills = identityOverride
      ? [...contextBase, identityOverride]
      : contextBase;

    // Layer 3 selection — pick `always` and `dynamic` (tool-affinity) skills
    // based on the active tool set. The merged pool
    // includes platform / workspace / user tier skills (user > workspace >
    // platform on name collisions). Bundle-exposed `skill://<name>/usage`
    // resources are synthesized into the pool as `dynamic` tool-affinity skills so a
    // workspace-level chat picks them up whenever the bundle's tools are
    // surfaced — no `appContext` scoping required (the prior path only fired
    // under `appContext`, missing cross-app workflows).
    //
    // Workspace-tier skills follow the FOCUSED workspace (the `/w/:slug` the
    // user is viewing), matching the briefing / apps / overlay surfaces.
    // On the home control panel there is no focus → fall back to the
    // session (personal) workspace, which is consistent with the rest of
    // home mode reading from the identity's personal scope. Pre-Stage-2
    // this was the request's wsId; Stage 2 (#272) inadvertently pinned it
    // to the personal workspace, silently dropping every shared-workspace
    // skill marked `loading_strategy: always`.
    // Reuse the pool computed for the per-request matcher above — same
    // `wsId` and `userId` — so the conversation-skill disk read happens once
    // per turn, not twice.
    const selectedLayer3 = await this.selectRequestLayer3({
      wsId: focusedWsId ?? sessionWsId,
      userId,
      activeToolNames: tools.map((t) => t.name),
      capabilityPool: poolCapability,
      ...(request.appContext?.serverName
        ? { appContextServerName: request.appContext.serverName }
        : {}),
    });
    const layer3Entries: Layer3SkillEntry[] = selectedLayer3.map((s) => ({
      name: s.skill.manifest.name,
      body: s.skill.body,
      scope: s.skill.manifest.scope ?? "org",
      ...(s.skill.sourcePath ? { sourcePath: s.skill.sourcePath } : {}),
      loadedBy: s.loadedBy,
      reason: s.reason,
    }));

    const { stableSystem, volatileHead } = composeSystemSegments(
      requestContextSkills,
      skill,
      apps,
      focusedApp,
      appState,
      prefs,
      proxied.length > 0,
      workspaceContext,
      liveOverlays,
      layer3Entries,
    );
    // Budget + telemetry size counts every segment: the volatile head still
    // consumes context even though it now rides the latest user message instead
    // of the cached system block (the prepend happens after telemetry, below).
    const systemPrompt = foldVolatileHead(stableSystem, volatileHead);

    // Workspace model overrides are in the RequestContext — read via getModelSlot()

    // Resolve model: support alias references (e.g., "alias:fast", "alias:reasoning")
    let resolvedModelString = request.model ?? this.getDefaultModel();
    const aliasSlot = parseAliasRef(resolvedModelString);
    if (aliasSlot) {
      resolvedModelString = this.getModelSlot(aliasSlot);
    }
    // Qualify bare model ids at the request-entry boundary. Slot-read
    // values are already qualified by `getModelSlots()`, but the per-
    // request `request.model` override path bypasses that reader, so
    // we normalize once here to cover both. Belt-and-suspenders with
    // the slot reader: the rest of the pipeline (cost aggregation,
    // capability checks, max-output and thinking resolvers, provider-
    // options shape, log lines) reads `engineConfig.model` directly
    // and depends on it being qualified.
    resolvedModelString = resolveModelString(resolvedModelString);

    // Load history and rehydrate any supported `resource_link` blocks
    // (attached files persisted as URI references) into AI SDK V3 `file`
    // parts with bytes loaded from the workspace FileStore. This is the seam
    // where the storage shape (URI references) meets the model-call
    // shape (inline bytes) — see `src/files/rehydrate.ts`.
    const history = await store.history(conversation);
    // File store is identity-scoped (Phase B): every file the user owns lives
    // at `users/{userId}/files/`, regardless of which workspace it was created
    // in. A `files://` URI persisted in any conversation resolves here against
    // the owner's single store — there is no per-workspace file silo to miss.
    const fileStore = this.getFileStore(ownerId);

    // Resolve maxOutputTokens FIRST — resolveThinking needs it to clamp the
    // thinking budget so visible-content headroom is always preserved.
    const resolvedMaxOutputTokens = resolveMaxOutputTokens({
      configValue: this.config.maxOutputTokens,
      model: resolvedModelString,
    });

    const resolvedThinking = resolveThinking({
      configMode: this.config.thinking,
      configBudgetTokens: this.config.thinkingBudgetTokens,
      model: resolvedModelString,
      maxOutputTokens: resolvedMaxOutputTokens,
    });

    // Compose the per-call message budget from the model's actual context
    // window minus the static per-call overhead. `configMaxInputTokens`
    // is treated as a CAP — never a target. See
    // `src/runtime/resolve-message-budget.ts`.
    const configMaxInputTokens = this.config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    const messageBudget = resolveMessageBudget({
      model: resolvedModelString,
      configMaxInputTokens,
      systemPrompt,
      tools,
      maxOutputTokens: resolvedMaxOutputTokens,
    });

    // History compaction (opt-in): when the conversation has outgrown its
    // budget, fold the oldest turns into a summary so the prefix re-anchors
    // once here instead of windowing — and busting the cache — every turn.
    // No-op unless `features.compaction` is on and the store is event-sourced;
    // best-effort, so a summarizer failure falls back to the full history.
    //
    // Plan/persist compaction on the RAW (un-rehydrated) history, then
    // rehydrate the result exactly once — rehydration inlines file bytes,
    // which the ts-keyed compaction estimate and summarizer transcript must
    // not see. NOTE: because the trigger estimate runs pre-rehydration, large
    // file extractions aren't counted toward the threshold, so compaction can
    // under-fire relative to true prompt size; the overflow windowing path
    // below still bounds the hard context limit.
    const compactedHistory = await this.maybeCompactHistory(
      store,
      conversation.id,
      history,
      messageBudget.budget,
    );
    const messages = await rehydrateUserResources(compactedHistory ?? history, fileStore, {
      model: resolvedModelString,
      maxExtractedTextSize: this.getFilesConfig().maxExtractedTextSize,
    });

    // Per-request hooks: inherit `beforeToolCall` from the runtime-level
    // hooks; compose `transformContext` here so the windowing budget is
    // the one we just resolved for THIS call. The order (slice → apply
    // provider replay policy → window by token budget) is preserved.
    const maxHistoryMessages = this.config.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
    const replayProvider = getProviderFromModel(resolvedModelString);
    const perRequestHooks: EngineHooks = {
      ...this.hooks,
      transformContext: (historyMessages, opts) => {
        // `overflowAttempt > 0` means the provider rejected the prior
        // call for exceeding the model's context window. Halve the
        // composed budget per attempt and re-window. The engine caps
        // recovery at one attempt today so this scales at most by 1/2.
        const attempt = opts?.overflowAttempt ?? 0;
        const budget =
          attempt > 0 ? Math.floor(messageBudget.budget / (1 << attempt)) : messageBudget.budget;
        const sliced = sliceHistory(historyMessages, maxHistoryMessages);
        const replayReady = applyReasoningReplayPolicy(sliced, replayProvider);
        return windowMessages(replayReady, budget);
      },
    };

    // Build pre-emit run telemetry tied to the engine's runId. The engine fires
    // these immediately after `run.start` and before any LLM call so the conv
    // log records what the prompt looked like for this turn — even if the LLM
    // call fails or the process is killed.
    const skillsLoaded = buildSkillsLoadedPayload(selectedLayer3);
    const contextAssembled = buildContextAssembledPayload({
      systemPrompt,
      activeTools: tools,
      messages,
      skillsLoaded,
    });

    // Evict the volatile head onto the latest user message so a per-turn change
    // (date, app/focused-app state, matched skill) no longer rewrites the
    // 1h-cached system prefix. Telemetry above counts every segment via
    // `systemPrompt`; the prepend runs after it, so history isn't double-counted.
    // Falls back to folding the head into the system string when there's no user
    // message to carry it (keeps the content, forgoes the cache win).
    const engineSystem = resolveEngineSystem(messages, stableSystem, volatileHead);

    const engineConfig: EngineConfig = {
      model: resolvedModelString,
      maxIterations: request.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      // Surfaced on run.start telemetry. The actual budget enforcement
      // happens inside `perRequestHooks.transformContext` above; this
      // value is reported for observability so operators can see what
      // the call was allotted vs. what it actually used.
      maxInputTokens: messageBudget.budget,
      maxOutputTokens: resolvedMaxOutputTokens,
      ...(resolvedThinking ? { thinking: resolvedThinking } : {}),
      maxToolResultSize: this.config.maxToolResultSize,
      hooks: perRequestHooks,
      runMetadata: {
        skillsLoaded,
        contextAssembled,
      },
      // Connector-skill overlays for the FOCUSED workspace — surfaced once
      // into history by the engine on a matching connector tool call, never
      // into the system prefix. Same workspace scoping as the layer-3 pool.
      connectorSkillCandidates: this.loadConnectorSkillCandidates(focusedWsId ?? sessionWsId),
      // Computed from the UN-rehydrated history — rehydrate strips the synthetic
      // marker's metadata, so the engine can't recover the already-injected set
      // from the messages it receives. This is what makes surface-ONCE hold
      // across turns on the real chat path.
      alreadyInjectedConnectorSkills: this.collectInjectedConnectorSkills(
        compactedHistory ?? history,
      ),
      // Cancellation: thread the caller's signal into the engine. The
      // engine checks it between iterations and forwards it down to every
      // tool call. Without this, callers racing the chat against a
      // deadline (notably the automations executor's `Promise.race`
      // against `maxRunDurationMs`) silently orphan in-flight work.
      ...(request.signal ? { signal: request.signal } : {}),
    };

    // Conversations are room-owned, so `store` (from `resolveChatStore`) is
    // always a per-call room store and is always the event sink. The
    // `this.eventStore`/`this.store` sentinel path below is VESTIGIAL —
    // `this.eventStore` is always null and `isWorkspaceRequest` always true.
    // TODO(cleanup): collapse to "always use the per-call room store" and drop
    // the boot-store fields. Deferred from this PR because removing `this.store`
    // is entangled with the `config.store` "embedding-only" story (also deferred).
    const isWorkspaceRequest =
      store instanceof EventSourcedConversationStore && store !== this.store;
    let activeEventStore: EventSourcedConversationStore | null = null;
    if (isWorkspaceRequest) {
      // Disable global store for this request, use workspace store instead
      if (this.eventStore) this.eventStore.setActiveConversation("");
      activeEventStore = store as EventSourcedConversationStore;
      activeEventStore.setActiveConversation(conversation.id);
    } else if (this.eventStore) {
      activeEventStore = this.eventStore;
      this.eventStore.setActiveConversation(conversation.id);
    }

    // Build per-request sink chain. The engine itself returns cumulative
    // usage and llmMs in its EngineResult — no need for a side-channel
    // metrics collector.
    const sinks: EventSink[] = requestSink
      ? [requestSink, this.defaultEvents]
      : [this.defaultEvents];
    if (isWorkspaceRequest) {
      sinks.push(store as EventSourcedConversationStore);
    }

    const model = engineConfig.model;
    const resolvedModel = this.resolveModelFn(model);

    // The engine's tool router is identity-bound but WALLED to one workspace.
    // It lists tools via `listToolsForWorkspace(workspaceId)` (the focused
    // workspace + identity tools) and dispatches each call through the
    // orchestrator (`routeToolCall`), which enforces the wall and constructs a
    // fresh `WorkspaceContext` from the parsed wsId. The chat hot path does NOT
    // read `runtime.requireWorkspaceId()` — per-call scope comes from the
    // routed namespace.
    //
    // The per-event sink is a wrapper around the request's sinks that
    // stamps `workspaceId` (resolved from the namespace) onto
    // `tool.progress` / `tool.done` events — the audit-attribution
    // contract. We can't compute the field from `requireWorkspaceId()`
    // because it doesn't exist at the chat-session level anymore; we
    // store the (call.id → wsId) mapping at dispatch time and read it
    // when the event fires.
    const perCallWorkspaceMap = new Map<string, string>();
    const wrappedSinks: EventSink[] = sinks.map((inner) =>
      this._wrapSinkWithWorkspaceAttribution(inner, perCallWorkspaceMap),
    );
    const engineSink = new MultiEventSink(wrappedSinks);
    const identityToolRouter = this._buildIdentityToolRouter({
      identityId: ownerId,
      workspaceId: toolsWsId,
      perCallWorkspaceMap,
    });
    const engine = new AgentEngine(resolvedModel, identityToolRouter, engineSink);

    // Build the request context for AsyncLocalStorage. `workspaceId` on
    // the RequestContext is the session (personal) workspace — the same
    // breadcrumb the conversation metadata records. Tool handlers that
    // need the per-call workspace must come through a WorkspaceContext
    // constructed by the orchestrator, NOT via
    // `runtime.requireWorkspaceId()`. Reading `requireWorkspaceId()` in
    // a tool handler now returns the session workspace, which is the
    // correct answer for session-scoped reads (overlays, file store) and
    // the wrong answer for per-call data. Per-call handlers should
    // accept a `WorkspaceContext` argument from the dispatch path
    // instead. T008 (credential rebinding) tightens this further.
    const reqCtx: RequestContext = {
      identity: requestIdentity,
      scope: {
        kind: "workspace",
        workspaceId: sessionWsId,
        workspaceAgents: sessionWorkspace?.agents ?? null,
        workspaceModelOverride: sessionWorkspace?.models ?? null,
      },
      conversationId: conversation.id,
    };
    engineConfig.toolPromotion = this.buildToolPromotionFactory();

    // Emit chat.start so the client knows the conversation ID immediately
    // and conversation list UIs can refresh
    if (requestSink) {
      requestSink.emit({
        type: "chat.start",
        data: { conversationId: conversation.id },
      });
      // Notify conversation browser UIs that a new conversation exists
      if (!request.conversationId) {
        requestSink.emit({
          type: "data.changed",
          data: { server: "conversations", tool: "list" },
        });
      }
    }

    // Root span for the agent turn — the common chokepoint for both the HTTP
    // and CLI entry points. Opened inside runWithRequestContext so the verified
    // identity is in scope; the llm.call and tool.dispatch spans nest under it.
    const result = await runWithRequestContext(reqCtx, () =>
      withSpan("agent.turn", { "llm.model": model, ...requestIdentityAttrs() }, () =>
        engine.run(engineConfig, engineSystem, messages, tools),
      ),
    );

    const usage: TurnUsage = {
      ...result.usage,
      model,
      llmMs: result.llmMs,
      iterations: result.iterations,
    };

    // If an event store handled the engine events (via emit()), the llm.response
    // events are already in the conversation file — no need for a separate append.
    // Only append the assistant message explicitly when no event store was active
    // (e.g., logging disabled, or legacy store without EventSink).
    const eventStoreHandled = !!activeEventStore;
    if (!eventStoreHandled) {
      await store.append(conversation, {
        role: "assistant",
        content: result.output
          ? [{ type: "text", text: result.output }]
          : [{ type: "text", text: "(tool use only)" }],
        timestamp: new Date().toISOString(),
        metadata: {
          skill: skill?.manifest.name ?? null,
          toolCalls: result.toolCalls,
          usage: result.usage,
          model,
          llmMs: result.llmMs,
          iterations: result.iterations,
        },
      });
    }

    // Fire-and-forget title generation on first turn (use "fast" slot for cost
    // savings). Decoupled from the turn lifecycle: when it resolves we persist
    // the title and broadcast `conversation.title` on the global SSE.
    //
    // No `emitConversationsChanged()` here — the conversation-list iframe
    // listens for `conversation.title` directly (forwarded via postMessage
    // by the web shell) and patches the matching row in-place. Firing
    // `data.changed` on title resolve used to trigger a full list refetch,
    // which was wasteful and caused row flicker. The global channel (not
    // the turn stream, which the client closes on `done`) means delivery
    // is reliable after the turn ends and across tabs — routed to the
    // right conversation by `conversationId`.
    //
    // Chaining `store.update(...).then(emit)` from the fulfillment handler
    // and a single `.catch()` on the outer promise means any rejection (model
    // timeout, ENOENT when the conversation was deleted between chat() returning
    // and the title landing) surfaces in the catch instead of as an unhandled
    // rejection that would fail the whole run.
    if (conversation.title === null) {
      const titleSlot = this.getModelSlot("fast");
      const titleModel = this.resolveModelFn(titleSlot);
      const titleInput =
        request.message ||
        `[Uploaded: ${request.fileRefs?.map((f) => f.filename).join(", ") || "files"}]`;
      // The title call runs the `fast` slot outside the agentic loop; persist
      // its usage as an aux.usage event so it isn't invisible to cost accounting.
      const appendTitleUsage = store.appendEvent?.bind(store);
      void generateTitle(titleModel, titleInput, result.output, (usage, llmMs) => {
        recordLlmUsage("title", titleSlot, usage);
        appendTitleUsage?.(conversation.id, {
          ts: new Date().toISOString(),
          type: "aux.usage",
          source: "title",
          model: titleSlot,
          usage,
          llmMs,
        });
      })
        .then(async (title) => {
          await store.update(conversation.id, { title });
          // `wsId: sessionWsId` (the owner's personal workspace) — NOT
          // `conversation.workspaceId`. The SSE layer (events.ts) scopes
          // `scope: "workspace"` events to clients whose membership set
          // contains this wsId. Conversations are owner-scoped, and the owner
          // is always a member of their own personal workspace, so this
          // reaches exactly the owner's tabs. Using the conversation's
          // workspaceId would be WRONG here: when the chat was focused on a
          // team workspace, that id fans the title out to every member of the
          // team — none of whom can see this owner-scoped conversation, so it
          // leaks the title string to their browsers for no benefit.
          // (The iframe list patch is routed by `conversationId`, not wsId, so
          // it's unaffected either way.) Stage 4 cross-user sharing must
          // revisit this — route by the conversation's ACL, not the owner's
          // personal ws — so an org-admin viewing another user's conversation
          // receives the live title.
          this.defaultEvents.emit({
            type: "conversation.title",
            data: { conversationId: conversation.id, title, wsId: sessionWsId },
          });
        })
        .catch((err) => {
          // Title generation is best-effort; a failed write must not crash
          // the chat. Common causes: model latency timeout (generateTitle),
          // or ENOENT on the conversation file (deleted concurrently).
          log.error("[runtime] title generation failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    return {
      response: result.output,
      conversationId: conversation.id,
      skillName: skill?.manifest.name ?? null,
      toolCalls: result.toolCalls,
      stopReason: result.stopReason,
      usage,
    };
  }

  /**
   * Unattended agent execution. Sibling primitive to `chat()` for
   * scheduled automations, eval runs, and future webhook-triggered jobs.
   *
   * Contract differences vs. `chat()`:
   *  - Each call writes a FRESH conversation; no resume, no concurrency
   *    lock (a re-entrant scheduler tick on the same automation creates
   *    two conversations, which is the correct semantic — each tick is
   *    its own task run).
   *  - The prompt goes in as a plain user message — no content parts,
   *    no file refs, no skill matching from prompt. Layer 3 (bundle
   *    workflow guidance) still applies based on the active tool set.
   *  - The system prompt is composed with `mode: "task"`, prepending
   *    `TASK_IDENTITY` so the model produces a deliverable rather than a
   *    conversational reply. The runtime owns this framing — bundles
   *    cannot spoof it by wrapping the user message.
   *  - `workspaceId` is optional: present → that workspace's tool scope +
   *    briefing; absent → the session (personal) workspace's tools + identity
   *    tools, no briefing layer. Either way the task is walled to one workspace.
   *  - No title generation, no `chat.start` SSE emit.
   *
   * NOTE (intentional duplication): much of the setup below mirrors
   * `_chatInner()`. The clean extraction (`_agentInvoke` substrate +
   * thin `chat()` / `executeTask()` siblings) is tracked as a planned
   * follow-up — see #334. Doing the extraction here would touch ~500
   * LOC of the most-trafficked code path in the runtime in the same PR
   * as the UI work, multiplying regression risk for the chat surface.
   * Shipped pragmatically; extracted properly in #334.
   */
  async executeTask(request: TaskRequest, requestSink?: EventSink): Promise<TaskResult> {
    // Identity resolution mirrors chat(): in production an identity provider
    // populates this; in dev mode we fall back to DEV_IDENTITY. Scheduler
    // callers pass `{ id: automation.ownerId }` as a minimal identity.
    const ownerId = resolveRequestOwnerId(request.identity, this._identityProvider !== null);
    const requestIdentity = request.identity ?? DEV_IDENTITY;

    // Session workspace (personal) — used for the silent dispatch reqCtx,
    // file store, and the workspace-agents / model overrides lookup. Never
    // narrated by the task prompt; the prompt only mentions the focused
    // workspace if one is set.
    const sessionWsId = personalWorkspaceIdFor(requestIdentity.id);
    await ensureUserWorkspace(this._workspaceStore, {
      id: requestIdentity.id,
      ...(requestIdentity.displayName ? { displayName: requestIdentity.displayName } : {}),
    });
    await this.ensureWorkspaceRegistry(sessionWsId);
    // The run conversation lives in its provenance room (the focused workspace,
    // or the owner's personal room when unfocused). When an automation id is
    // threaded it lands in that room's `_runs/<automationId>/` partition
    // (room-visible); otherwise the owner partition.
    const provRoomWsId = request.workspaceId ?? sessionWsId;
    const automationId =
      typeof request.metadata?.automationId === "string"
        ? request.metadata.automationId
        : undefined;
    // TODO(PR3): thread the automation id through the scheduler→executeTask
    // contract so every scheduled run lands in `_runs/<automationId>/`.
    const store: EventSourcedConversationStore = automationId
      ? this.runConversationStore(provRoomWsId, automationId)
      : this.roomConversationStore(provRoomWsId, ownerId);
    const sessionWorkspace = await this._workspaceStore.get(sessionWsId);

    // Always create a fresh conversation per task. No resume path —
    // `TaskRequest` has no `conversationId` field by design.
    const conversation = await store.create({
      ownerId,
      workspaceId: provRoomWsId,
      ...(automationId ? { automationId } : {}),
      metadata: { source: "task", ...(request.metadata ?? {}) },
    });

    await store.append(conversation, {
      role: "user",
      content: [{ type: "text", text: request.prompt }],
      timestamp: new Date().toISOString(),
      userId: requestIdentity.id,
    });

    // Workspace briefing (apps + overlays + workspace context). Same shape
    // as chat: gated on `focusedWsId`. When absent the briefing layers are
    // empty and `TASK_IDENTITY` is the dominant framing.
    const focusedWsId = request.workspaceId;
    const apps = focusedWsId ? await this.buildAppsList(focusedWsId) : [];
    const liveOverlays = focusedWsId
      ? await this.readPromptOverlays(focusedWsId)
      : { org: await this.getInstructionsStore().read({ scope: "org" }), workspace: "" };

    // Tool surfacing. The task is walled to one workspace: active set = the
    // focused workspace's tools (or the session/personal workspace if no focus)
    // + identity tools. `nb__search`'s corpus is that same workspace — no
    // cross-workspace reach.
    const toolsWsId = focusedWsId ?? sessionWsId;
    const toolsRegistry = await this.ensureWorkspaceRegistry(toolsWsId);
    const [focusedTools, identityTools] = await Promise.all([
      toolsRegistry.availableTools(),
      this.listIdentitySourceTools(),
    ]);
    const allTools: ToolSchema[] = [
      ...focusedTools
        .filter((t) => isToolVisibleToRole(t.name, requestIdentity.orgRole))
        .map((t) => ({
          name: namespacedToolName(toolsWsId, t.name),
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
        })),
      ...identityTools
        .filter((t) => isToolVisibleToRole(t.name, requestIdentity.orgRole))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
        })),
    ];
    const { direct: tools, proxied } = surfaceTools(allTools, null, {
      ...(request.allowedTools ? { requestAllowedTools: request.allowedTools } : {}),
    });

    const prefs = {
      displayName: requestIdentity.displayName ?? "",
      timezone: requestIdentity.preferences?.timezone ?? "",
      locale: requestIdentity.preferences?.locale ?? "en-US",
    };

    const activeWorkspace = focusedWsId
      ? focusedWsId === sessionWsId
        ? sessionWorkspace
        : await this._workspaceStore.get(focusedWsId)
      : undefined;
    const workspaceContext = focusedWsId
      ? activeWorkspace
        ? { id: activeWorkspace.id, name: activeWorkspace.name }
        : { id: focusedWsId }
      : undefined;

    const identityOverride = activeWorkspace?.identity
      ? makeIdentitySkill(activeWorkspace.identity)
      : null;

    // Layer 3 selection — bundle workflow guidance still applies based on
    // the active tool set. No `appContextServerName` (tasks don't have
    // appContext).
    //
    // Workspace-tier skills follow the FOCUSED workspace, falling back
    // to the session (personal) workspace only when the task has no
    // focus. This mirrors `_chatInner` (line ~1259, fixed in PR #315);
    // tasks scheduled against a shared workspace were silently dropping
    // every `loading_strategy: always` skill in that workspace before
    // this parity fix.
    const userId = requestIdentity.id;
    // Partition by role (same as `_chatInner`): context → Layer 0/1; capability
    // → conditional Layer 3. Disjoint by `type`, so no skill injects twice.
    const conversationPool = this.loadConversationSkills(focusedWsId ?? sessionWsId, userId);
    const { context: poolContext, capability: poolCapability } =
      partitionSkillsByRole(conversationPool);
    const contextBase = poolContext;
    const requestContextSkills = identityOverride
      ? [...contextBase, identityOverride]
      : contextBase;
    // Bundle skills come from the FOCUSED workspace only (the wall) — never
    // across the owner's other workspaces.
    const bundleSkills = await this.loadBundleSkills(focusedWsId ?? sessionWsId, {});
    const mergedLayer3Pool: Skill[] = [...poolCapability, ...bundleSkills];
    const activeToolNames = tools.map((t) => t.name);
    const selectedLayer3 = selectLayer3Skills({
      skills: mergedLayer3Pool,
      activeTools: activeToolNames,
    });
    const layer3Entries: Layer3SkillEntry[] = selectedLayer3.map((s) => ({
      name: s.skill.manifest.name,
      body: s.skill.body,
      scope: s.skill.manifest.scope ?? "org",
      ...(s.skill.sourcePath ? { sourcePath: s.skill.sourcePath } : {}),
      loadedBy: s.loadedBy,
      reason: s.reason,
    }));

    // Compose with mode: "task" — prepends TASK_IDENTITY before core skills.
    const { stableSystem, volatileHead } = composeSystemSegments(
      requestContextSkills,
      null, // no matched skill (task mode doesn't match on prompt)
      apps,
      undefined, // no focusedApp
      undefined, // no appState
      prefs,
      proxied.length > 0,
      workspaceContext,
      liveOverlays,
      layer3Entries,
      "task",
    );
    const systemPrompt = foldVolatileHead(stableSystem, volatileHead);

    // Model resolution — mirrors chat (alias slot + qualification).
    let resolvedModelString = request.model ?? this.getDefaultModel();
    const aliasSlot = parseAliasRef(resolvedModelString);
    if (aliasSlot) {
      resolvedModelString = this.getModelSlot(aliasSlot);
    }
    resolvedModelString = resolveModelString(resolvedModelString);

    // Load the freshly-appended user message. Rehydration happens once below,
    // after compaction (no-op here since there are typically no file refs —
    // the rehydrate call is a pass-through for shape consistency with the
    // engine's message contract).
    const history = await store.history(conversation);
    const fileStore = this.getFileStore(ownerId);

    const resolvedMaxOutputTokens = resolveMaxOutputTokens({
      configValue: this.config.maxOutputTokens,
      model: resolvedModelString,
    });
    const resolvedThinking = resolveThinking({
      configMode: this.config.thinking,
      configBudgetTokens: this.config.thinkingBudgetTokens,
      model: resolvedModelString,
      maxOutputTokens: resolvedMaxOutputTokens,
    });
    // Per-request override beats config beats default. The UI exposes a
    // per-automation `maxInputTokens` field; honoring it here makes that
    // setting actually take effect. Chat (_chatInner) has the same field
    // on ChatRequest but currently ignores it in favor of config-only —
    // tracked as #335 (parallel scoped fix to bring chat into semantic
    // consistency with task).
    const configMaxInputTokens =
      request.maxInputTokens ?? this.config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    const messageBudget = resolveMessageBudget({
      model: resolvedModelString,
      configMaxInputTokens,
      systemPrompt,
      tools,
      maxOutputTokens: resolvedMaxOutputTokens,
    });

    // History compaction (opt-in): when the conversation has outgrown its
    // budget, fold the oldest turns into a summary so the prefix re-anchors
    // once here instead of windowing — and busting the cache — every turn.
    // No-op unless `features.compaction` is on and the store is event-sourced;
    // best-effort, so a summarizer failure falls back to the full history.
    //
    // Plan/persist compaction on the RAW (un-rehydrated) history, then
    // rehydrate the result exactly once — rehydration inlines file bytes,
    // which the ts-keyed compaction estimate and summarizer transcript must
    // not see. NOTE: because the trigger estimate runs pre-rehydration, large
    // file extractions aren't counted toward the threshold, so compaction can
    // under-fire relative to true prompt size; the overflow windowing path
    // below still bounds the hard context limit.
    const compactedHistory = await this.maybeCompactHistory(
      store,
      conversation.id,
      history,
      messageBudget.budget,
    );
    const messages = await rehydrateUserResources(compactedHistory ?? history, fileStore, {
      model: resolvedModelString,
      maxExtractedTextSize: this.getFilesConfig().maxExtractedTextSize,
    });

    const maxHistoryMessages = this.config.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
    const replayProvider = getProviderFromModel(resolvedModelString);
    const perRequestHooks: EngineHooks = {
      ...this.hooks,
      transformContext: (historyMessages, opts) => {
        const attempt = opts?.overflowAttempt ?? 0;
        const budget =
          attempt > 0 ? Math.floor(messageBudget.budget / (1 << attempt)) : messageBudget.budget;
        const sliced = sliceHistory(historyMessages, maxHistoryMessages);
        const replayReady = applyReasoningReplayPolicy(sliced, replayProvider);
        return windowMessages(replayReady, budget);
      },
    };

    const skillsLoaded = buildSkillsLoadedPayload(selectedLayer3);
    const contextAssembled = buildContextAssembledPayload({
      systemPrompt,
      activeTools: tools,
      messages,
      skillsLoaded,
    });

    // Evict the volatile head onto the latest user message so a per-turn change
    // (date, app/focused-app state, matched skill) no longer rewrites the
    // 1h-cached system prefix. Telemetry above counts every segment via
    // `systemPrompt`; the prepend runs after it, so history isn't double-counted.
    // Falls back to folding the head into the system string when there's no user
    // message to carry it (keeps the content, forgoes the cache win).
    const engineSystem = resolveEngineSystem(messages, stableSystem, volatileHead);

    const engineConfig: EngineConfig = {
      model: resolvedModelString,
      maxIterations: request.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      maxInputTokens: messageBudget.budget,
      maxOutputTokens: resolvedMaxOutputTokens,
      ...(resolvedThinking ? { thinking: resolvedThinking } : {}),
      maxToolResultSize: this.config.maxToolResultSize,
      hooks: perRequestHooks,
      runMetadata: { skillsLoaded, contextAssembled },
      // Connector-skill overlays — same focused-workspace scoping as the
      // layer-3 pool; surfaced once into history, never the system prefix.
      connectorSkillCandidates: this.loadConnectorSkillCandidates(focusedWsId ?? sessionWsId),
      // Computed from the UN-rehydrated history — rehydrate strips the synthetic
      // marker's metadata, so the engine can't recover the already-injected set
      // from the messages it receives. This is what makes surface-ONCE hold
      // across turns on the real chat path.
      alreadyInjectedConnectorSkills: this.collectInjectedConnectorSkills(
        compactedHistory ?? history,
      ),
      ...(request.signal ? { signal: request.signal } : {}),
    };

    // Event store routing — same as chat: the task's per-call room store is
    // always the sink; the `this.eventStore` branch is vestigial (always null).
    // TODO(cleanup): collapse with the chat path (see `_chatInner`).
    const isWorkspaceRequest =
      store instanceof EventSourcedConversationStore && store !== this.store;
    let activeEventStore: EventSourcedConversationStore | null = null;
    if (isWorkspaceRequest) {
      if (this.eventStore) this.eventStore.setActiveConversation("");
      activeEventStore = store as EventSourcedConversationStore;
      activeEventStore.setActiveConversation(conversation.id);
    } else if (this.eventStore) {
      activeEventStore = this.eventStore;
      this.eventStore.setActiveConversation(conversation.id);
    }

    const sinks: EventSink[] = requestSink
      ? [requestSink, this.defaultEvents]
      : [this.defaultEvents];
    if (isWorkspaceRequest) {
      sinks.push(store as EventSourcedConversationStore);
    }

    // Per-run usage accumulator. The engine returns its cumulative usage only
    // on a clean exit; on an abort it throws and discards it (engine.ts run.error
    // path). But `executeTask`'s contract (see `TaskResult` docstring) promises a
    // result on completion "including timeout" — silent abandonment is the worst
    // failure mode. So we mirror the engine's per-call accounting from the events
    // it emits (same llm.done/tool.done shape PostHogEventSink reads) and retain
    // it across the throw, letting a timed-out automation report the work it
    // actually did instead of 0/0/0/0. Drops with the process — a real SIGKILL
    // still reports zero (the on-disk conversation JSONL remains the post-mortem).
    const partial = { inputTokens: 0, outputTokens: 0, iterations: 0, llmMs: 0 };
    const partialToolCalls: TaskResult["toolCalls"] = [];
    const usageAccumulator: EventSink = {
      emit(event: EngineEvent): void {
        const { type, data } = event;
        if (type === "llm.done") {
          partial.iterations += 1;
          partial.llmMs += (data.llmMs as number) ?? 0;
          const usage = (data.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
          partial.inputTokens += usage.inputTokens ?? 0;
          partial.outputTokens += usage.outputTokens ?? 0;
        } else if (type === "tool.done") {
          // `errorReason` is intentionally absent here: this accumulator only
          // feeds the abort/timeout path, which always returns
          // `stopReason: "aborted"` (never "complete"), so the automations
          // de-masker's `status === "success"` guard never reads it. (The
          // `tool.done` event doesn't carry `errorReason` either — no point
          // threading it through for a path that can't de-mask.)
          partialToolCalls.push({
            id: (data.id as string) ?? "",
            name: (data.name as string) ?? "",
            input: {},
            output: (data.output as string) ?? "",
            ok: (data.ok as boolean) ?? false,
            ms: (data.ms as number) ?? 0,
          });
        }
      },
    };
    sinks.push(usageAccumulator);

    const model = engineConfig.model;
    const resolvedModel = this.resolveModelFn(model);
    const perCallWorkspaceMap = new Map<string, string>();
    const wrappedSinks: EventSink[] = sinks.map((inner) =>
      this._wrapSinkWithWorkspaceAttribution(inner, perCallWorkspaceMap),
    );
    const engineSink = new MultiEventSink(wrappedSinks);
    const identityToolRouter = this._buildIdentityToolRouter({
      identityId: ownerId,
      workspaceId: toolsWsId,
      perCallWorkspaceMap,
    });
    const engine = new AgentEngine(resolvedModel, identityToolRouter, engineSink);

    const reqCtx: RequestContext = {
      identity: requestIdentity,
      scope: {
        kind: "workspace",
        workspaceId: sessionWsId,
        workspaceAgents: sessionWorkspace?.agents ?? null,
        workspaceModelOverride: sessionWorkspace?.models ?? null,
      },
      conversationId: conversation.id,
    };
    engineConfig.toolPromotion = this.buildToolPromotionFactory();

    let result: EngineResult;
    try {
      result = await runWithRequestContext(reqCtx, () =>
        engine.run(engineConfig, engineSystem, messages, tools),
      );
    } catch (err) {
      // Non-abort errors are genuine failures — rethrow so the caller
      // records a real failure. An abort (wall-clock timeout or external
      // cancel from the automations executor) is NOT a failure to be
      // discarded: honor the `TaskResult` contract and return what the run
      // accomplished before it was stopped, tagged `stopReason: "aborted"`
      // so the caller classifies timeout-vs-cancel from its own signal.
      if (!engineConfig.signal?.aborted) throw err;
      return {
        output: "",
        conversationId: conversation.id,
        toolCalls: partialToolCalls,
        stopReason: "aborted",
        usage: {
          inputTokens: partial.inputTokens,
          outputTokens: partial.outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          model,
          llmMs: partial.llmMs,
          iterations: partial.iterations,
        },
      };
    }

    const usage: TurnUsage = {
      ...result.usage,
      model,
      llmMs: result.llmMs,
      iterations: result.iterations,
    };

    // Persist assistant message (the deliverable) so the conversation
    // trace is complete and the UI's "Open conversation →" affordance
    // shows the full output. Same eventStoreHandled gate as chat().
    const eventStoreHandled = !!activeEventStore;
    if (!eventStoreHandled) {
      await store.append(conversation, {
        role: "assistant",
        content: result.output
          ? [{ type: "text", text: result.output }]
          : [{ type: "text", text: "(tool use only)" }],
        timestamp: new Date().toISOString(),
        metadata: {
          skill: null,
          toolCalls: result.toolCalls,
          usage: result.usage,
          model,
          llmMs: result.llmMs,
          iterations: result.iterations,
        },
      });
    }

    return {
      output: result.output,
      conversationId: conversation.id,
      toolCalls: result.toolCalls,
      stopReason: result.stopReason,
      usage,
    };
  }

  // ── Stage 2 (T006) — identity-bound chat helpers ─────────────────

  /**
   * Construct the chat surface's identity-bound `ToolRouter`.
   *
   * Thin wrapper around `IdentityToolRouter` (`./identity-tool-router.ts`)
   * that wires the audit-attribution hook to the chat-session's per-call
   * workspace map. The map is read by the sink wrap on `tool.progress` /
   * `tool.done` to stamp `workspaceId` from the ROUTED namespace — not the
   * session's focused workspace — so cross-workspace dispatches attribute
   * correctly in audit logs.
   */
  private _buildIdentityToolRouter(opts: {
    identityId: string;
    workspaceId: string;
    perCallWorkspaceMap: Map<string, string>;
  }): ToolRouter {
    const { identityId, workspaceId, perCallWorkspaceMap } = opts;
    return new IdentityToolRouter({
      identityId,
      workspaceId,
      runtime: this,
      onWorkspaceDispatch: (callId, wsId) => {
        perCallWorkspaceMap.set(callId, wsId);
      },
    });
  }

  /**
   * Wrap an `EventSink` so `tool.progress` / `tool.done` events carry
   * `workspaceId` from the per-call dispatch map. The map is populated
   * inside `_buildIdentityToolRouter` BEFORE `source.execute(...)` so
   * an early `tool.progress` event from a task-augmented tool can find
   * its entry. The map entry stays through `tool.done` so the audit
   * record sees the same field, then is deleted to keep the map bounded.
   *
   * `data` is `Record<string, unknown>` on `EngineEvent`; we copy the
   * existing object, write the `workspaceId` field, and re-emit. No
   * `as unknown as T` shenanigans — the field is `unknown`-typed by
   * construction so a plain assignment works.
   */
  private _wrapSinkWithWorkspaceAttribution(
    inner: EventSink,
    perCallWorkspaceMap: Map<string, string>,
  ): EventSink {
    return {
      emit: (event) => {
        if (event.type === "tool.progress" || event.type === "tool.done") {
          const id = typeof event.data.id === "string" ? event.data.id : undefined;
          if (id) {
            const wsId = perCallWorkspaceMap.get(id);
            if (wsId !== undefined) {
              const augmented = { ...event.data, workspaceId: wsId };
              if (event.type === "tool.done") {
                // Done is terminal — drop the entry now to keep the map
                // bounded across long-running conversations.
                perCallWorkspaceMap.delete(id);
              }
              inner.emit({ type: event.type, data: augmented });
              return;
            }
          }
        }
        inner.emit(event);
      },
    };
  }

  async reloadSkills(): Promise<void> {
    const all = loadAllSkills(this.config.skillDirs, globalSkillDir(this.config));
    const core = loadCoreSkills();
    const combined = [...core, ...all];
    const { context, skills } = partitionSkills(combined);
    this.contextSkills = context;
    this.skillMatcher.load(skills);
  }

  /** Get available tools across all workspace registries (for startup diagnostics). */
  async availableTools(): Promise<ToolSchema[]> {
    // Aggregate tools from all workspace registries for diagnostics
    const allTools: ToolSchema[] = [];
    const seen = new Set<string>();
    for (const reg of this._workspaceRegistries.values()) {
      for (const t of await reg.availableTools()) {
        if (!seen.has(t.name)) {
          seen.add(t.name);
          allTools.push(t);
        }
      }
    }
    return allTools;
  }

  /** Get registered bundle/source names across all workspace registries. */
  bundleNames(): string[] {
    const names = new Set<string>();
    for (const reg of this._workspaceRegistries.values()) {
      for (const n of reg.sourceNames()) names.add(n);
    }
    return [...names];
  }

  /** Get MCP sources across all workspace registries (for health monitoring). */
  mcpSources(): McpSource[] {
    const sources: McpSource[] = [];
    const seen = new Set<string>();
    for (const reg of this._workspaceRegistries.values()) {
      for (const s of reg.getSources()) {
        if (s instanceof McpSource && !seen.has(s.name)) {
          seen.add(s.name);
          sources.push(s);
        }
      }
    }
    return sources;
  }

  /** Get all tracked bundle instances (unfiltered — use getBundleInstancesForWorkspace for scoped access). */
  getBundleInstances(): BundleInstance[] {
    return this.lifecycle.getInstances();
  }

  /**
   * Get bundle instances visible in a specific workspace.
   *
   * `inst.wsId === wsId` is the authoritative scope — every BundleInstance
   * carries a required workspace. `visible.has(serverName)` is a
   * belt-and-suspenders check against orphaned lifecycle records whose
   * source has been removed from the registry.
   */
  getBundleInstancesForWorkspace(wsId: string): BundleInstance[] {
    const wsRegistry = this._workspaceRegistries.get(wsId);
    if (!wsRegistry) return [];
    const visible = new Set(wsRegistry.sourceNames());
    return this.lifecycle
      .getInstances()
      .filter((inst) => inst.wsId === wsId && visible.has(inst.serverName));
  }

  /** Get the lifecycle manager (for health monitor integration). */
  getLifecycle(): BundleLifecycleManager {
    return this.lifecycle;
  }

  /** Get the PlacementRegistry (for UI shell layout). */
  getPlacementRegistry(): PlacementRegistry {
    return this.placementRegistry;
  }

  /** Get the TelemetryManager instance. */
  getTelemetryManager(): TelemetryManager {
    return this.telemetryManager;
  }

  /** Get the resolved feature flags (needed by server.ts for HTTP gate in task 007). */
  getFeatures(): ResolvedFeatures {
    return this._features;
  }

  /**
   * Build the engine-config `toolPromotion` factory for a single agent run.
   * Both the top-level Runtime.chat() engine.run() AND any nested engine
   * (e.g. delegate sub-agents) call this so each engine gets its OWN
   * promotion controls installed in the request context for the lifetime
   * of its run. The save/restore in `registerControls` lets nested engines
   * stack: parent installs → child installs (saves parent) → child
   * unregister restores parent → parent unregister deletes.
   *
   * Without this isolation, AsyncLocalStorage propagates the parent's
   * `reqCtx.toolPromotion` into the child's frame; a sub-agent calling
   * nb__manage_tools would silently mutate the parent's directTools and
   * its own changes would never reach its own modelTools. See the
   * regression test in test/unit/engine.test.ts.
   */
  buildToolPromotionFactory(): NonNullable<EngineConfig["toolPromotion"]> {
    const features = this._features;
    return {
      isToolEligible: (tool) =>
        isToolEligibleForPromotion(tool, getRequestContext()?.identity?.orgRole, features),
      registerControls: (controls) => {
        const ctx = getRequestContext();
        if (!ctx) {
          // No request context = no place to install controls. Caller's
          // unregister becomes a no-op; their nb__manage_tools handler
          // hits the "no_active_run" path. Acceptable degradation.
          return () => {};
        }
        const prev = ctx.toolPromotion;
        ctx.toolPromotion = controls;
        return () => {
          if (prev === undefined) {
            delete ctx.toolPromotion;
          } else {
            ctx.toolPromotion = prev;
          }
        };
      },
    };
  }

  /** Scoped internal-API auth token (the internal-API bearer). Rotated on every restart. */
  getInternalToken(): string {
    return this._internalToken;
  }

  /**
   * Fetch the `skill://<serverName>/usage` resource for a bundle, with caching.
   *
   * Negative results (resource absent, source not MCP, transport error) are
   * cached as a `null` sentinel — the common case is "this bundle has no skill
   * resource," and re-issuing the read on every chat over a stable bundle set
   * would N×-multiply the request-path latency.
   *
   * `SharedSourceRef`-wrapped sources are unwrapped before the `McpSource`
   * check; shared sources arrive wrapped and would otherwise be
   * silently invisible to this path.
   */
  private async getAppSkillResource(serverName: string): Promise<string | null> {
    const cached = this.skillResourceCache.get(serverName);
    if (cached && Date.now() - cached.fetchedAt < Runtime.SKILL_CACHE_TTL) {
      return cached.content;
    }

    // Search across all workspace registries for the source
    let source: ToolSource | undefined;
    for (const reg of this._workspaceRegistries.values()) {
      source = reg.getSources().find((s) => s.name === serverName);
      if (source) break;
    }
    const unwrapped = source instanceof SharedSourceRef ? source.unwrap() : source;
    if (!(unwrapped instanceof McpSource)) {
      this.skillResourceCache.set(serverName, { content: null, fetchedAt: Date.now() });
      return null;
    }

    let body: string | null = null;
    try {
      const resource = await unwrapped.readResource(`skill://${serverName}/usage`);
      const content = resource?.text ?? null;
      if (content) {
        // Token budget: cap at ~3000 tokens (~12000 chars). Heading-aware
        // so we don't slice mid-sentence (production case: a "rules" appendix
        // at the end of a SKILL.md was lost mid-rule, breaking the model's
        // tool-selection logic).
        const capped = truncateMarkdownToBudget(content, MAX_SKILL_BODY_CHARS);
        body = capped.body;
        if (capped.truncated) {
          log.warn(
            `[skill] bundle usage skill truncated to ${MAX_SKILL_BODY_CHARS} chars (${capped.sectionsOmitted} section(s) omitted) — ${serverName}`,
          );
        }
      }
    } catch {
      // Resource doesn't exist or read failed — fall through to negative cache.
    }
    this.skillResourceCache.set(serverName, { content: body, fetchedAt: Date.now() });
    return body;
  }

  /** Check if an MCP source exposes a specific resource URI. */
  private async hasResource(source: McpSource, uri: string): Promise<boolean> {
    try {
      const data = await source.readResource(uri);
      return data !== null;
    } catch {
      return false;
    }
  }

  /**
   * Probe every MCP source in `wsId`'s registry for a `skill://<name>/usage`
   * resource and synthesize a Layer 3 `Skill` for any that responds. Each
   * synthesized skill is `dynamic` with tool-affinity `<name>__*`, so it loads via the
   * standard `selectLayer3Skills` path whenever the bundle's tools are in
   * the active toolset — no `appContext` required.
   *
   * Use case: a workspace-level chat where the model needs the bundle's
   * workflow guidance but isn't "entered" into the app. Without this, the
   * skill lived only on the `appContext`-scoped `<app-guide>` path and was
   * invisible to cross-bundle chats.
   *
   * Resource fetches reuse `getAppSkillResource`'s 5-minute cache, so this
   * stays cheap on warm requests. Per-source errors are swallowed (resource
   * not found is the normal not-published case).
   */
  private async loadBundleSkills(
    wsId: string,
    options: { appContextServerName?: string } = {},
  ): Promise<Skill[]> {
    const registry = this._workspaceRegistries.get(wsId);
    if (!registry) return [];

    // Candidate sources: MCP-backed (unwrapping `SharedSourceRef` so shared
    // sources are visible), and not the one already injected via
    // `<app-guide>` in `appContext` chats — otherwise the same body lands
    // twice in the prompt under two different framings.
    //
    // No trust-score gate: if a bundle is active its tools are callable, so
    // suppressing the workflow guidance that teaches the model how to use them
    // safely would make the situation worse, not better. Trust is enforced at
    // install time. See `formatFocusedAppSection` for the matching policy on
    // the `<app-guide>` path.
    // Servers with a materialized connector overlay: skip synthesizing
    // their `skill://<server>/usage` guidance — the curated overlay supersedes
    // it (and would otherwise double the guidance under two framings). A bundle
    // "has an overlay" iff its persisted ref carries a non-empty `skillsLock`.
    const overlaidServers = new Set(
      this.getBundleInstancesForWorkspace(wsId)
        .filter((i) => i.ref && "skillsLock" in i.ref && (i.ref.skillsLock?.length ?? 0) > 0)
        .map((i) => i.serverName),
    );

    const candidates: string[] = [];
    for (const source of registry.getSources()) {
      if (source.name === options.appContextServerName) continue;
      if (overlaidServers.has(source.name)) continue;
      const inner = source instanceof SharedSourceRef ? source.unwrap() : source;
      if (!(inner instanceof McpSource)) continue;
      candidates.push(source.name);
    }

    // Parallel fetch: serial probing N-times-multiplied the chat hot-path
    // latency on workspaces with many non-skill bundles. `getAppSkillResource`
    // caches both positive and negative results so steady-state cost is zero.
    const synthesized = await Promise.all(
      candidates.map(async (name) => {
        try {
          const body = await this.getAppSkillResource(name);
          return body ? synthesizeBundleSkill({ serverName: name, body }) : null;
        } catch {
          return null;
        }
      }),
    );
    return synthesized.filter((s): s is Skill => s !== null);
  }

  /**
   * Build apps list from in-memory lifecycle instances for system-prompt
   * injection (§7.3).
   *
   * Each app's `customInstructions` overlay comes from the bundle itself —
   * the platform reads `app://instructions` from the bundle's MCP
   * server on every assembly. Bundles that don't publish that resource get
   * no overlay (no UI surfaces, no behavior change). The platform's job is
   * the convention: read the URI, wrap the body in `<app-custom-instructions>`
   * containment in `formatAppsSection`. Bundles own storage, the agent tool
   * to write, validation, and the editor UI.
   */
  /** Public so the compose-effective-context debug tool can re-gather the same
   *  inputs `runtime.chat()` uses, without duplicating the bundle-instructions
   *  fetch logic. Workspace-scoped via the wsId argument; no privilege escalation. */
  async buildAppsList(workspaceId: string): Promise<PromptAppInfo[]> {
    const instances = this.getBundleInstancesForWorkspace(workspaceId);
    const registry = this._workspaceRegistries.get(workspaceId);

    const apps: PromptAppInfo[] = [];
    for (const instance of instances) {
      const trustScore = instance.trustScore ?? 0;
      let ui: PromptAppInfo["ui"] = null;
      if (instance.ui) {
        ui = { name: instance.ui.name };
      }

      // Surface the MCP server's `initialize.instructions` (when set) so the
      // LLM sees per-bundle guidance — typically a pointer to `skill://`
      // resources that explain correct tool usage. Without this hint the
      // agent cannot discover that such resources exist.
      let instructions: string | undefined;
      let customInstructions: string | undefined;
      const source = registry?.getSource(instance.serverName);
      if (source instanceof McpSource) {
        instructions = source.getInstructions();
        // Reserved platform convention: `app://instructions`. A bundle that
        // supports user-set custom instructions publishes its current overlay
        // body at this URI; the platform reads it on every assembly and
        // renders it inside `<app-custom-instructions>` containment in
        // `formatAppsSection`.
        //
        // Why `app://` over `<serverName>://instructions`: the serverName is
        // platform-derived (e.g. `@nimblebraininc/synapse-collateral` →
        // `synapse-collateral`), not something a bundle author intuitively
        // knows. A fixed scheme means bundle authors just remember
        // `app://instructions` and the platform's name-derivation rules are
        // not part of the contract.
        //
        // Resource-not-found returns `null` from `readResource` (the SDK's
        // normal not-found path); we treat any read error or empty body as
        // "bundle does not support / has none". Plain MCP servers (no
        // opt-in) end up here.
        try {
          const data = await source.readResource("app://instructions");
          const body = data?.text;
          const trimmedLen = typeof body === "string" ? body.trim().length : 0;
          // Visible under NB_DEBUG=mcp — confirms the platform fetched
          // app://instructions per active bundle and shows the resulting
          // body length. "len=0" + "set=false" for bundles that don't
          // publish; "set=true" + len=N for bundles that do.
          log.debug(
            "mcp",
            `app-instructions source=${instance.serverName} fetched=${data !== null} len=${trimmedLen} set=${trimmedLen > 0}`,
          );
          if (typeof body === "string" && body.trim().length > 0) {
            customInstructions = body;
          }
        } catch (err) {
          log.debug(
            "mcp",
            `app-instructions source=${instance.serverName} error=${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      apps.push({
        name: instance.serverName,
        description: instance.description,
        instructions,
        ...(customInstructions !== undefined ? { customInstructions } : {}),
        trustScore,
        ui,
      });
    }
    return apps;
  }

  /** Get the default event sink. */
  getEventSink(): EventSink {
    return this.defaultEvents;
  }

  /**
   * Resolve the host-resources deps for a workspace. Used by install
   * paths that don't go through `BundleLifecycleManager`: connector-tools
   * (Composio install eager-start), workspace-runtime (boot reload).
   * Returns `undefined` only when the runtime was constructed without the
   * host-resources subsystem wired — never in production. Callers should
   * thread the returned deps into `startBundleSource` (or
   * `installBundleInWorkspace`) via the `bundleMcp` opt so the spawned
   * McpSource registers inbound `ai.nimblebrain/resources/*` handlers.
   */
  getBundleMcpDeps(wsId: string): BundleMcpDeps | undefined {
    return this._bundleMcpDepsFactory?.(wsId);
  }

  /**
   * Get a per-workdir `InstructionsStore` for the org / workspace overlays.
   * Per-bundle instructions are NOT stored here — bundles own their storage
   * and publish a `app://instructions` resource if and only if they
   * support the convention. The store is stateless aside from the rooted
   * workdir, so a fresh instance per call is fine.
   */
  getInstructionsStore(): InstructionsStore {
    return new InstructionsStore(this.getWorkDir());
  }

  /**
   * Read the org and workspace instruction overlays for a system-prompt
   * assembly. Per-bundle overlays are NOT read here — they're populated on
   * `PromptAppInfo.customInstructions` directly in `buildAppsList`.
   *
   * Reads happen on every call (no caching) per the locked decision: edits
   * must apply mid-conversation.
   */
  /** Public so the compose-effective-context debug tool can re-read overlays
   *  in live mode. Workspace-scoped; no caller-controlled escalation. */
  async readPromptOverlays(wsId: string): Promise<{ org: string; workspace: string }> {
    const store = this.getInstructionsStore();
    const [org, workspaceOverlay] = await Promise.all([
      store.read({ scope: "org" }),
      store.read({ scope: "workspace", wsId }),
    ]);
    return { org, workspace: workspaceOverlay };
  }

  /** Get the ToolRegistry for a specific workspace. Throws if workspace registry not found. */
  getRegistryForWorkspace(wsId: string): ToolRegistry {
    const reg = this._workspaceRegistries.get(wsId);
    if (!reg) {
      throw new Error(
        `No registry for workspace "${wsId}". Workspace may not be provisioned yet — call ensureWorkspaceRegistry() first.`,
      );
    }
    return reg;
  }

  /**
   * Orchestrator self-heal hook (`OrchestratorRuntime.recoverWorkspaceSource`).
   * Best-effort, cooldown-guarded re-registration of an installed source
   * that went missing from a workspace registry — a failed credential
   * respawn or a remote-OAuth teardown that removed it without re-adding.
   * Delegates to the lifecycle manager and never throws; returns whether
   * the source is registered after the attempt.
   */
  async recoverWorkspaceSource(wsId: string, sourceName: string): Promise<boolean> {
    return this.lifecycle.tryRecoverSource(sourceName, wsId, this.getWorkDir());
  }

  /**
   * Resolve a kernel identity-scoped source by name. v1 set: `conversations`
   * (Files / Automations join when their data moves to identity ownership).
   * Returns `undefined` for an unknown or non-identity source. No workspace:
   * these dispatch with identity authority and gate reads via `canAccess`.
   */
  getIdentitySource(name: string): ToolSource | undefined {
    if (!isIdentitySource(name)) return undefined;
    return this._platformSources.find((s) => s.name === name);
  }

  /**
   * List the kernel identity sources' tools (conversations, …), source-
   * qualified (`conversations__list`). These are emitted BARE — owned by the
   * user, not any workspace — and prepended to the session's one workspace
   * tools by `listToolsForWorkspace`; on `/mcp` (identity-only, no workspace)
   * they are the entire tool list. Resolved from `_platformSources` (the whole
   * set, already started by `createPlatformSources`); identity sources are NOT
   * in any workspace registry, so this is the only path that lists them.
   * Per-source error containment mirrors the workspace lister.
   */
  async listIdentitySourceTools(): Promise<readonly Tool[]> {
    const all: Tool[] = [];
    for (const source of this._platformSources) {
      if (!isIdentitySource(source.name)) continue;
      try {
        for (const tool of await source.tools()) all.push(tool);
      } catch (err) {
        log.debug(
          "mcp",
          `[runtime] identity-source listing: skipping "${source.name}" — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return all;
  }

  /** Fresh `IdentityContext` for the authenticated identity. No workspace. */
  getIdentityContext(identityId: string): IdentityContext {
    return new IdentityContext({ userId: identityId, workDir: this.getWorkDir() });
  }

  /**
   * Resolve the owning user id for a request identity, applying the strict
   * production-vs-dev rule (see `resolveRequestOwnerId`). The thin instance
   * wrapper that passes whether an identity provider is configured — REST
   * handlers call this so they resolve the SAME owner `chat()` does.
   */
  resolveRequestUserId(identity: UserIdentity | undefined): string {
    return resolveRequestOwnerId(identity, this._identityProvider !== null);
  }

  /**
   * The identity-scoped file store for a user (`users/{userId}/files/`).
   * Files are identity-owned (Phase B), so this is the single sanctioned
   * `FileStore` constructor outside the store module itself — `check:file-paths`
   * rejects any workspace-scoped files dir. Cheap (closures over a path); not
   * memoized here because callers are per-request.
   */
  getFileStore(userId: string): FileStore {
    return createFileStore(this.getIdentityContext(userId).getDataPath("files"));
  }

  /** Get the ToolRegistry for the current request's workspace (from AsyncLocalStorage context). */
  getRegistryForCurrentWorkspace(): ToolRegistry {
    const wsId = this._currentWorkspaceId?.();
    if (!wsId) {
      throw new Error("No workspace in request context. Every request must be workspace-scoped.");
    }
    return this.getRegistryForWorkspace(wsId);
  }

  /**
   * Tools the model can DISCOVER via a system-tool surface (`nb__search`
   * scope:tools). The corpus is the FOCUSED workspace only — that workspace's
   * tools (namespaced `ws_<id>-<tool>`) plus the caller's identity tools. A
   * session reaches exactly one workspace plus the user's identity tools;
   * there is no cross-workspace discovery. `nb__search` dispatches as
   * `ws_<focused>-nb__search`, so the per-call request scope here is already
   * the focused workspace — we read it and list that registry.
   *
   * Falls back to the current workspace's registry when no workspace is in
   * scope (CLI / non-identity-bound dev paths).
   */
  async listDiscoverableTools(): Promise<readonly ToolSchema[]> {
    const ctx = getRequestContext();
    const wsId =
      ctx?.scope.kind === "workspace" ? ctx.scope.workspaceId : this._currentWorkspaceId?.();
    if (!wsId) {
      return this.getRegistryForCurrentWorkspace().availableTools();
    }
    return this.listToolsForWorkspace(wsId);
  }

  /**
   * The walled tool surface for a session bounded to `wsId`: that workspace's
   * tools (namespaced `ws_<id>-<tool>`) plus the caller's identity tools
   * (bare). The engine's reachable universe (`IdentityToolRouter.availableTools`)
   * and the `nb__search` corpus (`listDiscoverableTools`) both read this — a
   * session reaches exactly one workspace plus identity tools.
   */
  async listToolsForWorkspace(wsId: string): Promise<ToolSchema[]> {
    const registry = await this.ensureWorkspaceRegistry(wsId);
    const [wsTools, identityTools] = await Promise.all([
      registry.availableTools(),
      this.listIdentitySourceTools(),
    ]);
    return [
      ...wsTools.map((t) => ({
        name: namespacedToolName(wsId, t.name),
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
      })),
      ...identityTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
      })),
    ];
  }

  /** Get the per-workspace registries map. */
  getWorkspaceRegistries(): Map<string, ToolRegistry> {
    return this._workspaceRegistries;
  }

  /**
   * Ensure a ToolRegistry exists for a workspace, creating one if needed.
   *
   * Validates that the workspace exists in the WorkspaceStore before creating
   * a registry. Returns the existing registry if one is already present.
   * This is the JIT counterpart to the boot-time registry creation in
   * startWorkspaceBundles — both use createWorkspaceRegistry() for consistency.
   */
  async ensureWorkspaceRegistry(wsId: string): Promise<ToolRegistry> {
    const existing = this._workspaceRegistries.get(wsId);
    if (existing) return existing;

    // Security: only create registries for workspaces that actually exist
    const ws = await this._workspaceStore.get(wsId);
    if (!ws) {
      throw new Error(`Workspace "${wsId}" does not exist`);
    }

    const wsRegistry = createWorkspaceRegistry(this._workspaceSources, this._systemSource);
    // Wire permission context so the registry can gate disallowed tools
    // before they reach the source.execute() path.
    wsRegistry.setPermissionContext(wsId, this.getPermissionStore());
    this._workspaceRegistries.set(wsId, wsRegistry);
    return wsRegistry;
  }

  /**
   * Process-wide conversation locator: resolves a `convId` to the room +
   * owner it's stored under, and serves the cross-room (All-rooms) and
   * room-scoped list views. Lazily built over the workspaces root; invalidated
   * via `notifyConversationsChanged` on every conversation write and on
   * workspace archive-delete.
   */
  getConversationLocator(): ConversationLocator {
    if (!this._conversationLocator) {
      this._conversationLocator = new ConversationLocator(this._workspaceStore.getWorkspacesDir());
    }
    return this._conversationLocator;
  }

  /**
   * Subscribe to conversation changes (create / delete / append, and workspace
   * archive-delete). The conversations-tool index registers here so it refreshes
   * off the same invalidation signal the locator uses — one hook, both caches,
   * no divergent freshness. Returns an unsubscribe function.
   */
  onConversationsChanged(listener: () => void): () => void {
    this._conversationsChangedListeners.add(listener);
    return () => this._conversationsChangedListeners.delete(listener);
  }

  /**
   * Invalidate every conversation cache. The single freshness chokepoint:
   * room stores call this on create/delete/append (via `onMutate`), and a
   * workspace archive-delete calls it (via the membership-change hook), so the
   * locator and the conversations-tool index never serve a frozen summary or a
   * ghost of a deleted room.
   *
   * Scaling note: invalidation is tenant-wide and per-append, so under
   * concurrent chat the *list* index (summaries) rarely stays warm — the next
   * `listConversations` rebuilds by re-reading headers across rooms. The hot
   * per-message resume path does NOT pay this (locate is a readdir-only walk,
   * see `ConversationLocator.locate`); only list views do. The recursive room
   * layout rules out the old `fs.watch` debounce-coalescing, so before a
   * high-conversation tenant feels it, the move is a per-room / incremental
   * index (update one entry on the changed conv's room) rather than a full
   * tenant-wide rebuild. Out of scope here; correctness over the dead watcher.
   */
  notifyConversationsChanged(): void {
    this._conversationLocator?.invalidate();
    for (const listener of this._conversationsChangedListeners) {
      try {
        listener();
      } catch (err) {
        log.warn(`[runtime] conversations-changed listener threw: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Conversation store for a user's private chats in ONE room
   * (`workspaces/<wsId>/conversations/<ownerId>/`). The room owns the
   * directory — the path is the boundary. Per-call instances are intentional
   * (the store is stateless w.r.t. its dir); the `onMutate` hook keeps the
   * conversation caches fresh on every write.
   */
  roomConversationStore(wsId: string, ownerId: string): EventSourcedConversationStore {
    return new EventSourcedConversationStore({
      dir: roomConversationsDir(resolveWorkDir(this.config), wsId, ownerId),
      logLevel: this.config.logging?.level ?? "normal",
      onMutate: () => this.notifyConversationsChanged(),
    });
  }

  /**
   * Conversation store for an automation's run conversations in one room
   * (`workspaces/<wsId>/conversations/_runs/<automationId>/`, room-visible).
   */
  runConversationStore(wsId: string, automationId: string): EventSourcedConversationStore {
    return new EventSourcedConversationStore({
      dir: runConversationsDir(resolveWorkDir(this.config), wsId, automationId),
      logLevel: this.config.logging?.level ?? "normal",
      onMutate: () => this.notifyConversationsChanged(),
    });
  }

  /**
   * Resolve a conversation id to the room store that holds it, or `null` if no
   * room contains it. The single bridge from a bare `convId` (deep link,
   * history fetch, event append) to its room-owned store.
   */
  async resolveConversationStore(convId: string): Promise<EventSourcedConversationStore | null> {
    const loc = await this.getConversationLocator().locate(convId);
    if (!loc) return null;
    return loc.automationId
      ? this.runConversationStore(loc.wsId, loc.automationId)
      : this.roomConversationStore(loc.wsId, loc.ownerId ?? "");
  }

  /**
   * Resolve the room store for a chat turn. On resume the conversation's room
   * is authoritative (read from the locator); for a new conversation it's the
   * room the chat is born in (`createRoomWsId` = the focused workspace, or the
   * caller's personal room when unfocused). Returns the store plus the resolved
   * room id so the create path can stamp the binding.
   */
  private async resolveChatStore(
    conversationId: string | undefined,
    createRoomWsId: string,
    ownerId: string,
  ): Promise<{ store: EventSourcedConversationStore; roomWsId: string }> {
    if (conversationId) {
      // Hot path: the conversation almost always lives in the focused/personal
      // room under the caller's own owner partition. Probe that one path
      // directly (O(1) `existsSync`) before any cross-room walk — a resume runs
      // on every message, so this must not scan the tenant.
      const directDir = roomConversationsDir(resolveWorkDir(this.config), createRoomWsId, ownerId);
      if (existsSync(join(directDir, `${conversationId}.jsonl`))) {
        return {
          store: this.roomConversationStore(createRoomWsId, ownerId),
          roomWsId: createRoomWsId,
        };
      }
      // Cross-room deep-link: resolve by path (a readdir-only walk, no reads).
      const loc = await this.getConversationLocator().locate(conversationId);
      if (loc) {
        // An automation-run conversation (no owner partition) resolves to its
        // `_runs/` store — never split-brain a fresh file into the owner
        // partition under the same id.
        const store = loc.automationId
          ? this.runConversationStore(loc.wsId, loc.automationId)
          : this.roomConversationStore(loc.wsId, loc.ownerId ?? ownerId);
        return { store, roomWsId: loc.wsId };
      }
    }
    return { store: this.roomConversationStore(createRoomWsId, ownerId), roomWsId: createRoomWsId };
  }

  /**
   * Locate a conversation by id across rooms. Returns the `Conversation`
   * metadata, or `null` if no room holds it / the caller isn't the owner.
   *
   * Pass `access` to gate the read by ownership at the store layer. Without
   * `access` the caller asserts "I am the ownership boundary" (e.g.
   * `runtime.chat` after its own owner check); with it, the store returns
   * `null` for existence-but-not-yours, matching `load()`'s posture.
   */
  async findConversation(
    convId: string,
    access?: ConversationAccessContext,
  ): Promise<Conversation | null> {
    const store = await this.resolveConversationStore(convId);
    if (!store) return null;
    return store.load(convId, access);
  }

  /**
   * Append a conversation event to a conversation by id, resolving its room.
   * For out-of-band emitters (e.g. the briefing's `aux.usage`) that hold a
   * convId but not its room store. No-op if the conversation can't be located.
   */
  async appendConversationEvent(convId: string, event: ConversationEvent): Promise<void> {
    const store = await this.resolveConversationStore(convId);
    store?.appendEvent(convId, event);
  }

  /** Get the UserStore instance. */
  getUserStore(): UserStore {
    return this._userStore;
  }

  /** Get the WorkspaceStore instance. */
  getWorkspaceStore(): WorkspaceStore {
    return this._workspaceStore;
  }

  /**
   * Get the PermissionStore — per-tool policy lookups for installed
   * connectors. File-backed, scoped per (user × connector) and
   * (workspace × connector). Lazy + cached.
   */
  getPermissionStore(): PermissionStore {
    if (!this._permissionStore) {
      this._permissionStore = new PermissionStore(this.getWorkDir());
    }
    return this._permissionStore;
  }

  /**
   * Get the RegistryStore — instance-level config of which connector
   * registries (curated / mpak / future) are enabled. Auto-seeds with
   * sensible defaults on first read.
   *
   * Reserved for admin / mutation paths (the admin tool that updates
   * `enabled` / `url` / `scopes`). Read-side callers should use
   * `getConnectorDirectory()` instead — the directory facade owns the
   * source-construction, scope filter, projection, and lookup tables
   * uniformly.
   */
  getRegistryStore(): RegistryStore {
    if (!this._registryStore) {
      this._registryStore = new RegistryStore(this.getWorkDir());
    }
    return this._registryStore;
  }

  /**
   * Build a fresh `ConnectorDirectory` — the single read-side seam for
   * everything connector-catalog-shaped (Browse rows, raw
   * `ServerDetail[]`, lookup tables for Configure / installed-list).
   * Returns a new instance per call so per-instance memoization stays
   * scoped to one tool invocation; the underlying source caches (mpak
   * HTTP TTL, etc.) are still shared module-wide.
   */
  getConnectorDirectory(): ConnectorDirectory {
    return new ConnectorDirectory(this.getRegistryStore());
  }

  /** Get the IdentityProvider (null in dev mode when no instance.json). */
  getIdentityProvider(): IdentityProvider | null {
    return this._identityProvider;
  }

  /** Invalidate cached identity for a user. Call after modifying user data (preferences, role). */
  invalidateUserCache(userId: string): void {
    this._identityProvider?.invalidateUser?.(userId);
  }

  /** Get the current request's authenticated identity, or null. */
  getCurrentIdentity(): UserIdentity | null {
    return this._getIdentity();
  }

  /** Get the current request's workspace ID, or null. */
  getCurrentWorkspaceId(): string | null {
    return this._getWorkspaceId();
  }

  /**
   * Get the current request's workspace ID or throw.
   * Use this in any code path that must be workspace-scoped (tool handlers,
   * data access, facet collection). A missing workspace ID means the request
   * bypassed workspace middleware — that's a bug, not a fallback case.
   */
  requireWorkspaceId(): string {
    const id = this._getWorkspaceId();
    if (id) return id;
    throw new Error(
      "No workspace context — this code path requires a resolved workspace. " +
        "Ensure the request passes through workspace middleware.",
    );
  }

  /**
   * Construct a `WorkspaceContext` bound to `wsId` and the runtime's
   * `workDir`. The context is the typed handle to workspace-scoped paths
   * and the workspace credential store; call sites should prefer this to
   * `getWorkspaceScopedDir(wsId)` + `join` because it routes through the
   * single validation point (`WORKSPACE_ID_RE`) and forbids subpath
   * traversal.
   *
   * Instances are constructed fresh per call — they are lightweight (one
   * regex validation + a handful of field assignments) and immutable, so
   * sharing them across requests is never a correctness problem and not
   * sharing them avoids any cache-invalidation question when a workspace
   * is removed.
   */
  getWorkspaceContext(wsId: string): WorkspaceContext {
    return new WorkspaceContext({ wsId, workDir: resolveWorkDir(this.config) });
  }

  /**
   * Resolve the workspace-scoped data directory for the current request.
   * Returns `{workDir}/workspaces/{wsId}` when a workspace is active.
   * Dev mode (no identity provider) falls back to global workDir.
   */
  getWorkspaceScopedDir(wsId?: string | null): string {
    const id = wsId ?? this.getCurrentWorkspaceId();
    if (id) return this.getWorkspaceContext(id).getRoot();

    // Dev mode (no identity provider) — allow global fallback for local development
    if (!this._identityProvider) return resolveWorkDir(this.config);

    throw new Error("No workspace context — cannot resolve scoped directory.");
  }

  /**
   * Register the automations domain context getter. Called by the
   * automations platform source during construction. Internal callers
   * (CLI, lifecycle) read it back via `getAutomationsContext()` to bypass
   * the LLM-facing tool surface and call the domain API directly.
   */
  registerAutomationsContext(getter: () => AutomationDomainContext): void {
    this._automationsContextGetter = getter;
  }

  /**
   * Get a workspace-scoped automations domain context. Throws if the
   * automations source isn't registered (e.g. minimal test runtimes).
   * Each call returns a fresh context bound to the current request's
   * workspace — workspace switching between calls is safe.
   */
  getAutomationsContext(): AutomationDomainContext {
    if (!this._automationsContextGetter) {
      throw new Error(
        "Automations source not registered — runtime started without platform sources?",
      );
    }
    return this._automationsContextGetter();
  }

  /** Get the loaded InstanceConfig (null when no instance.json exists — dev mode). */
  getInstanceConfig(): InstanceConfig | null {
    return this._instanceConfig;
  }

  /** Get the resolved model slots (all three, with fallback logic).
   *  When a workspace model override is active (set per-request in chat()),
   *  workspace slots are merged over instance defaults.
   *
   *  All slot values are returned in fully-qualified `provider:id` form.
   *  Stored config can contain bare ids (legacy state from older settings
   *  UI saves); qualifying at the slot reader means every consumer of
   *  this method — engine config, get_config tool (which feeds the
   *  dropdown), telemetry, briefing — sees the same qualified shape
   *  without each having to remember to call `resolveModelString`. The
   *  per-request `request.model` override path (in `chat()`) qualifies
   *  separately because it bypasses this reader. */
  getModelSlots(): ModelSlots {
    const models = this.config.models;
    const fallback = this.config.defaultModel ?? DEFAULT_MODEL;
    const base: ModelSlots = {
      default: resolveModelString(models?.default ?? fallback),
      fast: resolveModelString(models?.fast ?? fallback),
      reasoning: resolveModelString(models?.reasoning ?? fallback),
    };
    // Merge workspace model overrides from request context (partial — only overrides specified slots)
    const scope = getRequestContext()?.scope;
    const wsModels = scope?.kind === "workspace" ? scope.workspaceModelOverride : null;
    if (wsModels) {
      return {
        default: wsModels.default ? resolveModelString(wsModels.default) : base.default,
        fast: wsModels.fast ? resolveModelString(wsModels.fast) : base.fast,
        reasoning: wsModels.reasoning ? resolveModelString(wsModels.reasoning) : base.reasoning,
      };
    }
    return base;
  }

  /** Get the model ID for a named slot. */
  getModelSlot(slot: ModelSlot): string {
    return this.getModelSlots()[slot];
  }

  /** Get the default model ID (shorthand for models.default). */
  getDefaultModel(): string {
    return this.getModelSlot("default");
  }

  /**
   * Compact a conversation's history at run start when it has outgrown its
   * budget — fold the oldest turns into a summary so the prefix re-anchors once
   * instead of windowing (and busting the cache) every turn. Opt-in via
   * `features.compaction`; event-sourced stores only (it persists a
   * `history.compacted` event). Returns the compacted `StoredMessage[]`, or
   * `null` when nothing changed (no flag, no `appendEvent`, or below threshold)
   * so the caller can skip re-rehydrating. Best-effort: the helper swallows
   * failures and returns the full history, never throwing into the chat path.
   */
  private async maybeCompactHistory(
    store: ConversationStore,
    conversationId: string,
    history: StoredMessage[],
    budget: number,
  ): Promise<StoredMessage[] | null> {
    if (!this.config.features?.compaction || !store.appendEvent) return null;
    const appendEvent = store.appendEvent.bind(store);
    const fastSlot = this.getModelSlot("fast");
    const model = this.resolveModelFn(fastSlot);
    const compacted = await compactConversationMessages(model, history, {
      budget,
      // Bound the summary call to the summarizer's own context — the fold is
      // sized by the main model's (larger) window, so without this it overflows
      // a smaller `fast` model and compaction silently no-ops.
      summarizerContextTokens: getModelByString(fastSlot)?.limits.context,
      now: new Date().toISOString(),
      onEvent: (event) => appendEvent(conversationId, event),
      onError: (err) =>
        log.error("[runtime] history compaction failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      // The summarizer runs the `fast` slot outside the agentic loop, so it
      // emits no llm.response. Persist its usage as an aux.usage event so the
      // fold's cost isn't invisible to the usage aggregator.
      onUsage: (usage, llmMs) => {
        recordLlmUsage("compaction", fastSlot, usage);
        appendEvent(conversationId, {
          ts: new Date().toISOString(),
          type: "aux.usage",
          source: "compaction",
          model: fastSlot,
          usage,
          llmMs,
        });
      },
    });
    // No-op contract: the helper returns the SAME array reference when nothing
    // was compacted (below threshold or best-effort failure). A future helper
    // that returns a copy would defeat this — the wiring integration test pins
    // that a below-threshold turn writes no history.compacted event.
    return compacted === history ? null : compacted;
  }

  /** Get the list of configured provider names (e.g., ["anthropic", "openai"]). */
  getConfiguredProviders(): string[] {
    if (this.config.providers) {
      return Object.keys(this.config.providers);
    }
    // Legacy config: single provider from model.provider
    if (
      this.config.model &&
      "provider" in this.config.model &&
      this.config.model.provider !== "custom"
    ) {
      return [this.config.model.provider];
    }
    return ["anthropic"];
  }

  /** Get provider configs with optional model allowlists. */
  getProviderConfigs(): Record<string, { models?: string[] }> {
    if (this.config.providers) {
      const result: Record<string, { models?: string[] }> = {};
      for (const [id, cfg] of Object.entries(this.config.providers)) {
        result[id] = { models: (cfg as { models?: string[] }).models };
      }
      return result;
    }
    if (
      this.config.model &&
      "provider" in this.config.model &&
      this.config.model.provider !== "custom"
    ) {
      return { [this.config.model.provider]: {} };
    }
    return { anthropic: {} };
  }

  /**
   * Tenant-level default preferences from the deployed runtime config
   * (`config.preferences` with `config.home` as a legacy fallback for
   * displayName/timezone). These are the values an operator sets via Helm
   * values; per-user identity preferences override them at request time.
   */
  getTenantDefaultPreferences(): {
    displayName?: string;
    timezone?: string;
    locale?: string;
    theme?: "system" | "light" | "dark";
  } {
    const prefs = this.config.preferences ?? {};
    const home = this.config.home ?? {};
    return {
      ...((prefs.displayName ?? home.userName)
        ? { displayName: prefs.displayName ?? home.userName }
        : {}),
      ...((prefs.timezone ?? home.timezone) ? { timezone: prefs.timezone ?? home.timezone } : {}),
      ...(prefs.locale ? { locale: prefs.locale } : {}),
      ...(prefs.theme ? { theme: prefs.theme } : {}),
    };
  }

  /** Get max agentic iterations per request. */
  getMaxIterations(): number {
    return this.config.maxIterations ?? 10;
  }

  /** Get max input tokens per request. */
  getMaxInputTokens(): number {
    return this.config.maxInputTokens ?? 500_000;
  }

  /**
   * Get max output tokens per LLM call.
   *
   * If a model is supplied, the value is resolved through the catalog so
   * the answer reflects what would actually be used for that model. Without
   * a model, the default-slot model is used (so the bare call returns the
   * cap that applies to a default chat turn).
   */
  getMaxOutputTokens(model?: string): number {
    return resolveMaxOutputTokens({
      configValue: this.config.maxOutputTokens,
      model: model ?? this.getDefaultModel(),
    });
  }

  /**
   * Update live runtime config (in-memory). Called by set_config tool
   * after disk write.
   *
   * For `thinking` and `thinkingBudgetTokens`, `null` is the explicit
   * "clear my override" sentinel — distinct from `undefined` (leave the
   * field alone). After clearing, the resolver falls back to the
   * platform default policy (adaptive for catalog-flagged reasoning
   * models, off otherwise).
   */
  updateConfig(patch: {
    defaultModel?: string;
    models?: Partial<ModelSlots>;
    maxIterations?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxToolResultSize?: number;
    thinking?: "off" | "adaptive" | "enabled" | null;
    thinkingBudgetTokens?: number | null;
    preferences?: Record<string, string>;
  }) {
    if (patch.models) {
      if (!this.config.models) {
        this.config.models = this.getModelSlots(); // init from current
      }
      Object.assign(this.config.models, patch.models);
    }
    if (patch.defaultModel !== undefined) {
      this.config.defaultModel = patch.defaultModel;
      // Also update models.default for consistency
      if (this.config.models) {
        this.config.models.default = patch.defaultModel;
      }
    }
    if (patch.maxIterations !== undefined) this.config.maxIterations = patch.maxIterations;
    if (patch.maxInputTokens !== undefined) this.config.maxInputTokens = patch.maxInputTokens;
    if (patch.maxOutputTokens !== undefined) this.config.maxOutputTokens = patch.maxOutputTokens;
    if (patch.maxToolResultSize !== undefined)
      this.config.maxToolResultSize = patch.maxToolResultSize;
    if (patch.thinking !== undefined) {
      if (patch.thinking === null) {
        this.config.thinking = undefined;
      } else {
        this.config.thinking = patch.thinking;
      }
    }
    if (patch.thinkingBudgetTokens !== undefined) {
      if (patch.thinkingBudgetTokens === null) {
        this.config.thinkingBudgetTokens = undefined;
      } else {
        this.config.thinkingBudgetTokens = patch.thinkingBudgetTokens;
      }
    }
  }

  /**
   * Raw boot-time context skills, INCLUDING any toggled Off. Audit/management
   * surfaces that must show disabled rules (e.g. `skills__list`) use this.
   * Anything that mirrors what the prompt actually contains must use
   * {@link activeContextSkills} instead — see its doc.
   */
  getContextSkills(): Skill[] {
    return this.contextSkills;
  }

  /**
   * BOOT-TIME context skills (org/core/builtin) with any toggled Off
   * (`status: "disabled"`) removed. Audit/management helper only.
   *
   * NOTE: the prompt composition path no longer reads this. Compose routes by
   * ROLE via `partitionSkillsByRole(loadConversationSkills(...))`, whose
   * `context` set spans EVERY tier (boot + workspace + user) and applies the
   * same active-status filter. This method is the boot-only subset — use it for
   * surfaces that only need the static vendored/org set, not for anything that
   * must mirror what the prompt actually contains (use the partitioned pool).
   * `reloadSkills()` refreshes `this.contextSkills` on every skills-tool
   * mutation, so the toggle is reflected here on the next turn.
   */
  activeContextSkills(): Skill[] {
    return this.contextSkills.filter(
      (s) => s.manifest.status === undefined || s.manifest.status === "active",
    );
  }

  /** Get loaded matchable skills (for skill_status tool). */
  getMatchableSkills(): Skill[] {
    return this.skillMatcher.getSkills();
  }

  /**
   * Phase 2 — per-conversation Layer 3 skill overlay.
   *
   * Returns the merged platform-tier + workspace-tier + user-tier set,
   * deduplicated by `manifest.name` with later scopes overriding earlier
   * ones (user > workspace > platform).
   *
   * All three tiers are evaluated fresh per call so authoring a skill
   * takes effect mid-session without a process restart:
   *
   *   - bundled (core + builtin from the source tree) — from the boot-
   *     time `contextSkills` cache, since those files are immutable.
   *   - platform (`{workDir}/skills/`) — fresh disk read, so writes via
   *     `skills__create` / `skills__update` surface immediately.
   *   - workspace (`{workDir}/workspaces/{wsId}/skills/`) — fresh.
   *   - user (`{workDir}/users/{userId}/skills/`) — fresh.
   *
   * The cached `contextSkills` set is filtered to entries whose
   * `sourcePath` is OUTSIDE the live platform dir, so a removed file
   * doesn't ghost in the listing as a stale boot-time cache hit.
   *
   * Each returned skill has `manifest.scope` populated.
   */
  loadConversationSkills(wsId: string, userId: string | null): Skill[] {
    const workDir = this.getWorkDir();
    const orgDirPrefix = `${join(workDir, "skills")}/`;

    const orgPool: Skill[] = [];
    // Bundled skills (core + builtin) — sourcePath sits outside the
    // live platform dir, so include from the cache. Skills loaded at
    // boot from the live dir are dropped here in favour of the fresh
    // read below; otherwise a deleted/moved platform skill would
    // re-appear from cache.
    for (const s of this.contextSkills) {
      if (!s.sourcePath?.startsWith(orgDirPrefix)) {
        orgPool.push(stampDerivedScope(workDir, s));
      }
    }
    for (const s of this.skillMatcher.getSkills()) {
      if (!s.sourcePath?.startsWith(orgDirPrefix)) {
        orgPool.push(stampDerivedScope(workDir, s));
      }
    }
    // Live org-tier dir, fresh every call.
    orgPool.push(...loadScopedSkills(join(workDir, "skills"), "org"));

    const workspaceDir = this.getWorkspaceContext(wsId).getDataPath("skills");
    const workspacePool = loadScopedSkills(workspaceDir, "workspace");

    const userPool: Skill[] = [];
    if (userId) {
      const userDir = join(workDir, "users", userId, "skills");
      userPool.push(...loadScopedSkills(userDir, "user"));
    }

    return mergeScopedSkills(orgPool, workspacePool, userPool);
  }

  /**
   * Connector-skill overlay candidates for a turn — curated connector
   * guidance materialized into the FOCUSED workspace's `connector-skills/`
   * store (a sibling of `skills/`). Returned as the engine's lightweight
   * candidate shape and handed to `engine.run` via
   * `EngineConfig.connectorSkillCandidates`, where the surface-once hook
   * matches them by tool-affinity. They are deliberately NOT merged into
   * `loadConversationSkills` — that pool composes into the system prompt /
   * Layer-3, and connector overlays must only ever ride the conversation
   * history. Empty when nothing was materialized (feature off, or no overlay
   * curated for the workspace's connectors).
   */
  loadConnectorSkillCandidates(wsId: string): ConnectorSkillCandidate[] {
    const dir = this.getWorkspaceContext(wsId).getDataPath(CONNECTOR_SKILLS_SUBDIR);
    return readConnectorSkillCandidates(dir);
  }

  /**
   * Names of connector overlays already surfaced in this conversation,
   * read from the reconstructed history's synthetic-message markers. MUST be
   * called on the UN-rehydrated history (`compactedHistory ?? history`):
   * `rehydrateUserResources` strips message `metadata`, so the marker is gone
   * from the rehydrated `messages` the engine receives. Passed to the engine as
   * `alreadyInjectedConnectorSkills` so a bound overlay is surfaced once across
   * the whole conversation, not re-injected every turn its tools are used.
   *
   * Compaction interaction (intended): reading from `compactedHistory ?? history`
   * means that once compaction folds the synthetic marker into a summary, the
   * overlay is no longer "already injected" and re-surfaces once on the next
   * matching tool call — re-establishing the guidance after the verbatim block
   * was summarized away. The cost is bounded (one re-injection per compaction).
   */
  private collectInjectedConnectorSkills(messages: StoredMessage[]): string[] {
    const names = new Set<string>();
    for (const m of messages) {
      const meta = m.metadata;
      if (meta?.synthetic === CONNECTOR_SKILL_SYNTHETIC && typeof meta.skill === "string") {
        names.add(meta.skill);
      }
    }
    return [...names];
  }

  /**
   * Materialized connector overlays in a workspace, with provenance — backs
   * `manage_connectors list_bound_skills`. Distinct from
   * {@link loadConnectorSkillCandidates} (the engine's lightweight pool): this
   * carries the bound server + source ref for an operator-facing listing.
   */
  listConnectorOverlays(wsId: string): ConnectorOverlayInfo[] {
    const dir = this.getWorkspaceContext(wsId).getDataPath(CONNECTOR_SKILLS_SUBDIR);
    return listConnectorOverlays(dir);
  }

  /**
   * Build the Layer-3 skill pool for a request and run the selection.
   *
   * Single source of truth for both prompt composition (`chat`) and the
   * `nb__status scope:skills` reporter (`describeRequestSkills`). Keeping the
   * pool construction in one place is deliberate: the bug this method exists to
   * prevent was status and composition reading skills through two divergent
   * paths, so the status surface reported only boot-time skills while the
   * prompt received the workspace/user-tier set.
   *
   * The pool merges per-conversation tier skills (org + workspace + user, via
   * {@link loadConversationSkills}) with bundle-exposed `skill://<name>/usage`
   * skills from the focused workspace only — a bundle installed there whose
   * tools land in the workspace's tool list must also surface its workflow
   * guidance, else the model gets the namespaced tool name with no
   * instructions. A bundle in another workspace never contributes here.
   * `selectLayer3Skills` then filters to the `dynamic` (tool-affinity)
   * strategy against `activeToolNames`.
   */
  async selectRequestLayer3(params: {
    /**
     * Focused workspace (or session/personal in home mode) — the ONLY workspace
     * whose workspace-tier AND bundle skills are in scope. Skills never cross a
     * workspace boundary.
     */
    wsId: string;
    /** Identity for user-tier skills; null in non-identity-bound paths. */
    userId: string | null;
    /** Names of tools in the set tool-affinity is evaluated against. */
    activeToolNames: string[];
    /** Skip a server's usage skill when its `<app-guide>` is already injected. */
    appContextServerName?: string;
    /**
     * Precomputed CAPABILITY skills (`type: skill`) from the conversation pool —
     * the output of `partitionSkillsByRole(...).capability`. When the caller
     * already partitioned for the per-request matcher / context channel, thread
     * it through so the disk read isn't repeated. Omitted callers (e.g.
     * `describeRequestSkills`) load + partition internally. Context skills are
     * NOT in this set — they compose into Layer 0/1 by role, never Layer 3.
     */
    capabilityPool?: Skill[];
  }): Promise<SelectedSkill[]> {
    const capabilityPool =
      params.capabilityPool ??
      partitionSkillsByRole(this.loadConversationSkills(params.wsId, params.userId)).capability;
    // Bundle skills come from the FOCUSED workspace only — a connector installed
    // in another workspace must not inject its usage skill here (the wall).
    const bundleSkills = await this.loadBundleSkills(params.wsId, {
      ...(params.appContextServerName ? { appContextServerName: params.appContextServerName } : {}),
    });
    return selectLayer3Skills({
      skills: [...capabilityPool, ...bundleSkills],
      activeTools: params.activeToolNames,
    });
  }

  /**
   * The Layer-3 skills the CURRENT request would compose into the prompt, plus
   * the boot-time context skills — for `nb__status scope:skills`.
   *
   * Reports through {@link selectRequestLayer3} (the same path `chat` composes
   * with) so the status surface reflects the workspace- and user-tier skills
   * actually loaded, not the boot-time cache. Identity and the focused
   * workspace come from the active request context.
   *
   * Active-tool input is the focused workspace's *available* tools. Under
   * progressive disclosure the live run's active subset may be smaller, but for
   * a status view "loads when this installed tool is active" is the signal a
   * reader wants — and it never under-reports an always-loaded skill.
   */
  async describeRequestSkills(
    wsId: string,
  ): Promise<{ context: readonly Skill[]; layer3: readonly SelectedSkill[] }> {
    const identity = getRequestContext()?.identity ?? undefined;
    const ownerId = this.resolveRequestUserId(identity);
    const userId = identity?.id ?? ownerId;
    const registry = await this.ensureWorkspaceRegistry(wsId);
    const activeToolNames = (await registry.availableTools()).map((t) => t.name);
    // Partition the same way compose does, so the status surface matches the
    // prompt exactly: `context` (every tier, active only) is the Layer 0/1 set;
    // `capability` feeds Layer 3. Reading the raw boot-time `this.contextSkills`
    // would both miss workspace/user-tier context skills and show toggled-Off
    // rules as active — the divergence this reporter exists to kill.
    const { context, capability } = partitionSkillsByRole(
      this.loadConversationSkills(wsId, userId),
    );
    const layer3 = await this.selectRequestLayer3({
      wsId,
      userId,
      activeToolNames,
      capabilityPool: capability,
    });
    return { context, layer3 };
  }

  /** Get the path to the nimblebrain.json config file (Helm-managed seed). */
  getConfigPath(): string | undefined {
    return this.config.configPath;
  }

  /**
   * Loose session-store config for the API host to resolve. The actual
   * defaulting + validation lives in `api/session-store/factory.ts` so this
   * returns whatever was put in `nimblebrain.json`, untouched.
   */
  getSessionStoreConfig(): RuntimeConfig["sessionStore"] {
    return this.config.sessionStore;
  }

  /**
   * Resolved idle TTL for sessions, in milliseconds. Two operator surfaces,
   * one currency:
   *
   *   - `MCP_SESSION_TTL_SECONDS` env var (highest priority — env wins so
   *     ops can flip TTL without redeploying the configmap)
   *   - `sessionStore.ttlSeconds` in `nimblebrain.json`
   *   - 8 h fallback
   *
   * Internal callers (registry constructors, sweep math) take ms; the
   * conversion happens once here so the rest of the runtime never deals
   * in mixed units. `parsePositiveIntEnv`-style validation lives in
   * `mcp-server.ts`; this accessor only consumes the parsed env value.
   */
  getSessionStoreTtlMs(): number {
    const envRaw = process.env.MCP_SESSION_TTL_SECONDS;
    if (envRaw !== undefined && envRaw !== "") {
      const parsed = Number(envRaw);
      if (Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed)) {
        return parsed * 1000;
      }
      // Invalid env value — fall through to config / default. We don't
      // log here because the chart-rendered config path is the typical
      // source of truth; an unset/typo'd env should be a quiet fallback,
      // not a noise generator on every cold start.
    }
    const seconds = this.config.sessionStore?.ttlSeconds ?? 8 * 60 * 60;
    return seconds * 1000;
  }

  /**
   * Get the path to nimblebrain.overrides.json — the user-managed override
   * file written by `set_model_config` and preserved across deploys.
   * Defaults to a sibling of `configPath`; absent only when no `configPath`
   * is set (in-memory tests, embedded usage).
   */
  getConfigOverridePath(): string | undefined {
    return this.config.configOverridePath;
  }

  /** Get current runtime config values (safe subset — no secrets). */
  getRuntimeConfig(): {
    models: ModelSlots;
    defaultModel: string;
    maxIterations: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    /** Operator-pinned thinking mode if set; absent when relying on model-default policy. */
    thinking?: "off" | "adaptive" | "enabled";
    thinkingBudgetTokens?: number;
  } {
    return {
      models: this.getModelSlots(),
      defaultModel: this.getDefaultModel(),
      maxIterations: this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      maxInputTokens: this.config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: resolveMaxOutputTokens({
        configValue: this.config.maxOutputTokens,
        model: this.getDefaultModel(),
      }),
      ...(this.config.thinking !== undefined ? { thinking: this.config.thinking } : {}),
      ...(this.config.thinkingBudgetTokens !== undefined
        ? { thinkingBudgetTokens: this.config.thinkingBudgetTokens }
        : {}),
    };
  }

  /** Resolve a model string to a LanguageModelV3 instance. */
  resolveModel(modelString: string): LanguageModelV3 {
    return this.resolveModelFn(modelString);
  }

  /** Get home dashboard configuration with defaults applied. */
  getHomeConfig(): { userName: string; timezone: string; cacheTtlMinutes: number } {
    const identity = this.getCurrentIdentity();
    return {
      userName: identity?.displayName ?? "there",
      timezone: identity?.preferences?.timezone ?? "",
      cacheTtlMinutes: this.config.home?.cacheTtlMinutes ?? 5,
    };
  }

  /** Get the structured log directory path. */
  getLogDir(): string {
    return this.config.logging?.dir ?? join(resolveWorkDir(this.config), "logs");
  }

  /** Get the resolved work directory path. */
  getWorkDir(): string {
    return resolveWorkDir(this.config);
  }

  /**
   * Absolute mpak home (`<workDir>/apps`). Single source of truth for the
   * cache path: `getMpak()` is a singleton keyed by this string, so every
   * caller must pass the SAME (resolved, absolute) form or the singleton
   * thrashes — `getWorkDir()` is NOT pre-resolved, so callers must use this,
   * not `join(getWorkDir(), "apps")`. Matches the value handed to the
   * lifecycle at construction.
   */
  getMpakHome(): string {
    return join(resolve(resolveWorkDir(this.config)), "apps");
  }

  /**
   * Whether the runtime allows OAuth flows / bundle URLs to target loopback
   * / RFC1918 / cloud-metadata hosts. Mirrors `config.allowInsecureRemotes`;
   * read by `/v1/mcp-auth/initiate` when constructing the workspace OAuth
   * provider so the SSRF allowlist matches the boot-time provider's behavior.
   */
  getAllowInsecureRemotes(): boolean {
    return this.config.allowInsecureRemotes === true;
  }

  /** Get the file context configuration with defaults applied. */
  getFilesConfig(): FileConfig {
    return { ...DEFAULT_FILE_CONFIG, ...this.config.files };
  }

  /** Build AppInfo list for GET /v1/apps endpoint (workspace-scoped). */
  async getApps(): Promise<AppInfo[]> {
    const registry = this.getRegistryForCurrentWorkspace();
    const wsId = this._currentWorkspaceId?.();
    if (!wsId) {
      throw new Error("No workspace in request context. Every request must be workspace-scoped.");
    }
    const apps: AppInfo[] = [];
    for (const instance of this.getBundleInstancesForWorkspace(wsId)) {
      let toolCount = 0;
      try {
        const source = registry.getSources().find((s) => s.name === instance.serverName);
        if (source) {
          const tools = await source.tools();
          toolCount = tools.length;
        }
      } catch {
        // Source may be stopped or crashed
      }
      apps.push({
        name: instance.serverName,
        bundleName: instance.bundleName,
        version: instance.version,
        status: instance.state,
        type: instance.type,
        toolCount,
        trustScore: instance.trustScore ?? 0,
        ui: instance.ui,
      });
    }
    return apps;
  }

  /**
   * List conversations across rooms via the locator. Pass `access` to filter
   * by ownership; without it the caller asserts trusted enumeration scope
   * (CLI, admin tools). Pass `options.workspaceId` for the room-scoped view (a
   * single room's chats); omit it for the owner's "All rooms" view. The room
   * filter is the path; ownership is the access gate — orthogonal axes.
   */
  async listConversations(
    options?: ListOptions,
    access?: ConversationAccessContext,
  ): Promise<ConversationListResult> {
    return this.getConversationLocator().list(options, access);
  }

  /**
   * Read a `ui://` resource from an app (workspace-scoped).
   *
   * Resolves an app — platform built-ins (in-process MCP) and user-installed
   * bundles (subprocess/remote MCP) — strictly through the workspace registry.
   * The lifecycle store tracks user-installed bundles only; platform sources
   * never appear there, so registry membership is the single authoritative
   * "is this app available to this workspace?" check.
   */
  async readAppResource(
    appName: string,
    resourcePath: string,
    wsId: string,
  ): Promise<ResourceData | null> {
    const registry = this.getRegistryForWorkspace(wsId);
    const source = registry.getSources().find((s) => s.name === appName);
    return this.readResourceFromSource(source, appName, resourcePath);
  }

  /**
   * Read a `ui://` resource from a kernel **identity** source (conversations,
   * …). Identity apps live outside any workspace, so the source is resolved
   * from the identity-source set — never a workspace registry. The caller
   * (the resource route) has already authenticated the session; reads here
   * are not workspace-gated. Returns `null` for an unknown/non-identity app.
   */
  async readIdentityAppResource(
    appName: string,
    resourcePath: string,
  ): Promise<ResourceData | null> {
    return this.readResourceFromSource(this.getIdentitySource(appName), appName, resourcePath);
  }

  /**
   * Shared `ui://` read against an already-resolved MCP source — the
   * workspace and identity hosts differ only in how they resolve the source.
   * Tries the exact `ui://<path>` first, then the source-namespaced
   * `ui://<app>/<path>`.
   */
  private async readResourceFromSource(
    source: ToolSource | undefined,
    appName: string,
    resourcePath: string,
  ): Promise<ResourceData | null> {
    if (!(source instanceof McpSource)) return null;

    // This is the app-surface (resource-proxy) read path — its only callers are
    // readAppResource / readIdentityAppResource serving a `ui://` resource for a
    // mounted app. A failure here is anomalous, so opt into logging; discovery
    // probes that read directly from a source stay silent.
    const opts = { logFailures: true } as const;

    if (resourcePath.includes("://")) {
      return source.readResource(resourcePath, opts);
    }

    const exactUri = `ui://${resourcePath}`;
    const namespacedUri = `ui://${appName}/${resourcePath}`;

    const result = await source.readResource(exactUri, opts);
    if (result !== null) return result;
    if (exactUri !== namespacedUri) return source.readResource(namespacedUri, opts);
    return null;
  }

  async shutdown(): Promise<void> {
    await this.telemetryManager.shutdown();
    // Abort every in-flight detached turn BEFORE removing the sources they
    // depend on. A detached turn's lifecycle is decoupled from any HTTP
    // request (it runs to completion server-side), so without this a turn
    // mid-`doStream()` keeps issuing tool calls into workspace sources that
    // the loop below is concurrently tearing down — late calls hit removed
    // sources. RunBus.reset() aborts each run's signal (the engine stops
    // cooperatively) and clears the run map. Order matters: stop the
    // producers first, then dismantle their dependencies.
    this.runBus.reset();
    // Stop all sources across all workspace registries
    for (const [_wsId, reg] of this._workspaceRegistries) {
      for (const name of reg.sourceNames()) {
        await reg.removeSource(name);
      }
    }
  }
}

// --- Factory helpers (keep Runtime.start() readable) ---

/**
 * Best-effort placement extraction for any ToolSource. `McpSource`
 * exposes `getPlacements()` (returning declarations from
 * `defineInProcessApp`); sources that don't declare any — including
 * external bundles, whose placements come from their manifest, not the
 * source — return `[]`.
 */
function readSourcePlacements(src: ToolSource): PlacementDeclaration[] {
  const fn = (src as { getPlacements?: () => unknown }).getPlacements;
  if (typeof fn !== "function") return [];
  const out = fn.call(src);
  return Array.isArray(out) ? (out as PlacementDeclaration[]) : [];
}

function resolveModel(config: RuntimeConfig): (modelString: string) => LanguageModelV3 {
  // New multi-provider config takes precedence
  if (config.providers) {
    return buildModelResolver({
      providers: config.providers,
    });
  }

  // Legacy config.model support
  if (config.model) {
    if (config.model.provider === "custom") {
      const adapter = config.model.adapter;
      return () => adapter;
    }

    // Convert legacy named provider to new format
    const providerName = config.model.provider;
    const providersCfg: Record<string, Record<string, unknown>> = {};

    if (providerName === "anthropic") {
      providersCfg.anthropic = { apiKey: config.model.apiKey };
    } else if (providerName === "openai") {
      providersCfg.openai = {
        apiKey: (config.model as { apiKey?: string }).apiKey,
        baseURL: (config.model as { baseURL?: string }).baseURL,
      };
    } else if (providerName === "google") {
      providersCfg.google = { apiKey: (config.model as { apiKey?: string }).apiKey };
    } else {
      throw new Error(`Unknown model provider: "${providerName}"`);
    }

    return buildModelResolver({
      providers: providersCfg as RuntimeConfig["providers"],
    });
  }

  // Default: anthropic with env var fallback
  return buildModelResolver({ providers: { anthropic: {} } });
}

/** Initialize work directory env vars and sync core skills. */
function initWorkDir(config: RuntimeConfig): void {
  const workDir = resolveWorkDir(config);
  const resolvedWorkDir = resolve(workDir);
  process.env.NB_WORK_DIR = resolvedWorkDir;
  // Co-locate mpak cache/config/tmp under NimbleBrain's state tree
  process.env.MPAK_HOME = join(resolvedWorkDir, "apps");

  // Sync core skills (soul.md) into the work dir so bundles can find them
  // without needing env vars that point into the source tree.
  syncCoreSkills(resolvedWorkDir);
}

function buildEventSink(config: RuntimeConfig): {
  events: EventSink;
  eventStore: EventSourcedConversationStore | null;
} {
  const sinks: EventSink[] = config.events ? [...config.events] : [];
  if (!config.logging?.disabled) {
    const workDir = resolveWorkDir(config);
    const logDir = config.logging?.dir ?? join(workDir, "logs");
    const retentionDays = config.logging?.retentionDays;
    // Workspace events (bundle lifecycle, bridge calls, audit) go to daily workspace log
    sinks.push(new WorkspaceLogSink({ dir: logDir, retentionDays }));
  }
  const events: EventSink = sinks.length > 0 ? new MultiEventSink(sinks) : new NoopEventSink();
  // No boot-time conversation event store: conversations are room-owned, so
  // every chat/task turn routes engine events through its own per-call room
  // store (the `isWorkspaceRequest` sink, always taken now). `this.eventStore`
  // stays null; there is no flat top-level conversations dir.
  return { events, eventStore: null };
}

function buildStore(config: RuntimeConfig): ConversationStore {
  if (config.store?.type === "memory") return new InMemoryConversationStore();
  if (config.store?.type === "jsonl") return new JsonlConversationStore(config.store.dir);
  if (config.store?.type === "custom") return config.store.adapter;
  // Default: conversations are room-owned (per-call room stores), so there is
  // no flat top-level store. `this.store` is only the sentinel the chat path
  // compares against (`store !== this.store` ⇒ use the per-call room store as
  // the event sink), so an in-memory placeholder is correct and never written.
  return new InMemoryConversationStore();
}

function buildSkills(config: RuntimeConfig): {
  contextSkills: Skill[];
  skillMatcher: SkillMatcher;
} {
  const all = loadAllSkills(config.skillDirs, globalSkillDir(config));
  const core = loadCoreSkills();
  const combined = [...core, ...all];
  const { context, skills } = partitionSkills(combined);
  const matcher = new SkillMatcher();
  matcher.load(skills);
  return { contextSkills: context, skillMatcher: matcher };
}

function loadAllSkills(configDirs?: string[], skillDir?: string): Skill[] {
  const skills: Skill[] = [];
  skills.push(...loadBuiltinSkills());
  if (skillDir) skills.push(...loadSkillDir(skillDir));
  for (const dir of configDirs ?? []) skills.push(...loadSkillDir(dir));
  return skills;
}

/**
 * Derive a scope for a skill loaded through the boot-time pool.
 *
 * `loadSkillDir`-style loaders (used for `loadCoreSkills`,
 * `loadBuiltinSkills`, plus `globalSkillDir` and any config-supplied
 * dirs) do not stamp scope, so the manifest arrives without one. We
 * can't unconditionally stamp `"org"` because core + builtin skills
 * live in the source tree (`src/skills/{core,builtin}/`), not under
 * `{workDir}/skills/` — they're vendored with the platform and not
 * mutable. The mutation tools' `scopeOfPath` already rejects those
 * paths as `"bundle"`; without this fix the UI would happily show an
 * Edit button for them and only fail on save.
 *
 * Decision matrix:
 *   - manifest.scope already set → trust the frontmatter
 *   - sourcePath under {workDir}/skills/ → real org-tier (live, mutable)
 *   - everything else → bundle (vendored, immutable)
 */
function stampDerivedScope(workDir: string, skill: Skill): Skill {
  if (skill.manifest.scope) return skill;
  const orgDir = `${join(workDir, "skills")}/`;
  const isOrg = skill.sourcePath?.startsWith(orgDir) ?? false;
  return {
    ...skill,
    manifest: { ...skill.manifest, scope: isOrg ? "org" : "bundle" },
  };
}

/**
 * Build the `context.assembled` snapshot from the assembled prompt + tool
 * set + history + Layer 3 skills counted in `skills.loaded`. The snapshot
 * carries counts and tokens only — never content (the bodies are already
 * in the conversation log via earlier source events / message history).
 *
 * Exported for tests — the regression we care about (image attachments not
 * inflating history tokens by 100×) is the integration between this builder
 * and `estimateMessageTokens`. Direct test access keeps the regression
 * verifiable without spinning a full Runtime.
 */
/**
 * Prepend the volatile "runtime context" head (current date, app/focused-app
 * state, matched skill) to the latest user message as a leading text part. This
 * keeps per-turn-volatile content OUT of the 1h-cached system block (where any
 * change rewrites the whole prefix at the premium write rate) and on the message
 * stream, which rides the rolling cache instead. Mutates `messages` in place.
 * Returns false when there's no user message to carry it (the caller then folds
 * the head back into the system string so nothing is dropped).
 */
function prependRuntimeContextToLastUserMessage(
  messages: LanguageModelV3Message[],
  volatileHead: string,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const headPart: LanguageModelV3TextPart = { type: "text", text: volatileHead };
    messages[i] = { ...m, content: [headPart, ...m.content] };
    return true;
  }
  return false;
}

/**
 * Fold the volatile head back into the system string with the canonical
 * separator. The single source of truth for that separator: the budget/telemetry
 * sizing and the engine-side fallback both go through here, so the two can never
 * drift (a mismatch would desync the token estimate from the prompt sent).
 */
function foldVolatileHead(stableSystem: string, volatileHead: string): string {
  return volatileHead ? `${stableSystem}\n\n${volatileHead}` : stableSystem;
}

/**
 * Resolve the system string handed to the engine: prepend the volatile head to
 * the latest user message (keeping it out of the 1h-cached prefix) and return
 * the stable system unchanged; if there's no user message to carry it, fold the
 * head back into the system string so nothing is dropped. Mutates `messages`.
 */
function resolveEngineSystem(
  messages: LanguageModelV3Message[],
  stableSystem: string,
  volatileHead: string,
): string {
  if (volatileHead && !prependRuntimeContextToLastUserMessage(messages, volatileHead)) {
    return foldVolatileHead(stableSystem, volatileHead);
  }
  return stableSystem;
}

export function buildContextAssembledPayload(input: {
  systemPrompt: string;
  activeTools: ToolSchema[];
  messages: LanguageModelV3Message[];
  skillsLoaded: SkillsLoadedPayload;
}): ContextAssembledPayload {
  const promptTokens = approxTokens(input.systemPrompt);
  // Tool descriptions: name + description + input schema. Routed through
  // `estimateToolDescriptionTokens` (not `approxTokens(JSON.stringify(t))`)
  // so we never hand a future object that could carry a `Uint8Array` to
  // `JSON.stringify` — the bug we just fixed on the history path.
  const toolDescTokens = input.activeTools.reduce(
    (sum, t) => sum + estimateToolDescriptionTokens(t),
    0,
  );
  // History tokens: walk content parts with `estimateMessageTokens`.
  //
  // The previous formula was `approxTokens(JSON.stringify(m))`, which for any
  // user message carrying a `file` part with `data: Uint8Array(<bytes>)`
  // (rehydrated images — see `src/files/rehydrate.ts`) inflated by 30-100×:
  // `JSON.stringify(Uint8Array)` expands to `{"0":n,"1":n,…}` (~12 chars/byte)
  // and the chars/4 heuristic over-counted by ~3 tokens per image byte. Two
  // ~700KB PNGs landed at 2.8M+ phantom tokens for a 51K-token call.
  const historyTokens = input.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const sources: ContextAssembledSource[] = [
    { kind: "system_prompt", tokens: promptTokens },
    { kind: "tool_descriptions", count: input.activeTools.length, tokens: toolDescTokens },
    {
      kind: "skills",
      count: input.skillsLoaded.skills.length,
      tokens: input.skillsLoaded.totalTokens,
    },
    { kind: "history", turns: input.messages.length, compacted: false, tokens: historyTokens },
  ];
  const totalTokens = sources.reduce((sum, s) => sum + s.tokens, 0);
  return { sources, excluded: [], totalTokens };
}

/**
 * Create a synthetic identity skill from a workspace's identity markdown.
 * Injected at priority 1 (core context layer) so it becomes the agent persona.
 */
/**
 * Exported so the compose-effective-context debug tool can build the
 * same per-request identity override `runtime.chat()` uses, instead of
 * silently composing against the bare global `contextSkills` (which
 * would lie about what's in the prompt for any workspace that has
 * `workspace.identity` set).
 */
export function makeIdentitySkill(body: string): Skill {
  return {
    manifest: {
      name: "identity-override",
      description: "Workspace identity override",
      loadingStrategy: "always",
      priority: 1,
      status: "active",
    },
    body,
    sourcePath: "",
  };
}

/**
 * Copy core skills (soul.md etc.) from the source tree into {workDir}/core/
 * so bundle subprocesses can find them via NB_WORK_DIR alone.
 */
function syncCoreSkills(workDir: string): void {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/core");
  const destDir = join(workDir, "core");
  if (!existsSync(srcDir)) return;
  mkdirSync(destDir, { recursive: true });
  // soul.md is the only core skill today; if more are added, iterate the dir.
  const soulSrc = join(srcDir, "soul.md");
  if (existsSync(soulSrc)) {
    copyFileSync(soulSrc, join(destDir, "soul.md"));
  }
}
