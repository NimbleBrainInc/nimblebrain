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
import { bootReconcileConnectorSkills } from "../bundles/connector-skill-reconcile.ts";
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
import { type ConversationLocation, ConversationLocator } from "../conversation/locator.ts";
import { workspaceConversationsDir } from "../conversation/paths.ts";
import type {
  Conversation,
  ConversationAccessContext,
  ConversationListResult,
  ConversationStore,
  CreateConversationOptions,
  ListOptions,
  StoredMessage,
} from "../conversation/types.ts";
import { applyReasoningReplayPolicy, windowMessages } from "../conversation/window.ts";
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
import { FileLocator } from "../files/locator.ts";
import { workspaceFilesDir } from "../files/paths.ts";
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
import {
  isDisallowed,
  type PermissionOwner,
  PermissionStore,
} from "../permissions/permission-store.ts";
import type {
  AppStateInfo,
  FocusedAppInfo,
  Layer3SkillEntry,
  PromptAppInfo,
} from "../prompt/compose.ts";
import { composeSystemSegments } from "../prompt/compose.ts";
import { ConnectorDirectory } from "../registries/directory.ts";
import { RegistryStore, warnIfCuratedCatalogEmpty } from "../registries/registry-store.ts";
import {
  BUNDLE_SKILL_SCOPE,
  type DiscoveredSkill,
  isSkillEntrypointUri,
  parseSkillMarkdown,
  synthesizeBundleSkill,
} from "../skills/bundle-skills.ts";
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
import type { Workspace } from "../workspace/types.ts";
import { personalWorkspaceIdFor, WorkspaceStore } from "../workspace/workspace-store.ts";
import {
  ConversationAccessDeniedError,
  ConversationWorkspaceAccessDeniedError,
  RunInProgressError,
  WorkspaceMembershipRevokedError,
} from "./errors.ts";
import { IdentityToolRouter } from "./identity-tool-router.ts";
import { PlacementRegistry } from "./placement-registry.ts";
import {
  getRequestContext,
  type RequestContext,
  type RequestScope,
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
import {
  createWorkspaceRegistry,
  type ProcessInventoryEntry,
  startWorkspaceBundles,
} from "./workspace-runtime.ts";

const DEFAULT_WORK_DIR = join(homedir(), ".nimblebrain");
const DEFAULT_MODEL = "claude-sonnet-4-6";

import { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_ITERATIONS } from "../limits.ts";
import { resolveMaxOutputTokens } from "./resolve-max-output-tokens.ts";
import { resolveMessageBudget } from "./resolve-message-budget.ts";
import { resolveThinking } from "./resolve-thinking.ts";
import { isToolEligibleForPromotion } from "./tool-eligibility.ts";

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
  private skillMatcher: SkillMatcher;
  private config: RuntimeConfig;
  private contextSkills: Skill[];
  /** Process-wide convId → workspace resolver; lazily built over the workspaces root. */
  private _conversationLocator?: ConversationLocator;
  private _fileLocator?: FileLocator;
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
   * Cache of the skills discovered on each MCP source (its `skill://…/SKILL.md`
   * resources, parsed + truncated). An empty array is the common "this server
   * publishes no skills" case — without caching it, `loadBundleSkills` would
   * re-list + re-read every non-skill source on every chat.
   */
  private skillResourceCache = new Map<string, { skills: DiscoveredSkill[]; fetchedAt: number }>();
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
    skillMatcher: SkillMatcher,
    config: RuntimeConfig,
    contextSkills: Skill[],
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
    this.skillMatcher = skillMatcher;
    this.config = config;
    this.contextSkills = contextSkills;
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
    // under the locator without going through a workspace store, so the cache would
    // otherwise keep ghosts (and a resume could re-mkdir the archived workspace).
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

    const baseEvents = buildEventSink(config);

    // Create delegate tracker and include it in the event pipeline
    const delegateTracker = new DelegateTracker();
    // Always-on, observe-only Prometheus counters. Process-local: increments in
    // memory whether or not `/metrics` is scraped, so it's safe in a local
    // `bun run dev` with no Prometheus/k8s.
    const sinkList: EventSink[] = [baseEvents, delegateTracker, new MetricsEventSink()];
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
    // Files are workspace-owned: a bundle's `files://` read/list resolves in the
    // workspace the bundle runs in (`ctx.workspaceId`, passed by the resolver)
    // under the session user's partition. The resolver fires inside the request
    // context the orchestrator set up for the bundle's tool call, so the
    // identity is in scope here; we resolve it with the same rule `chat()` uses
    // (`resolveRequestOwnerId`) so reads see exactly the files the agent does.
    // Memoize per (workspace, user) — FileStore is cheap closures today, but
    // per-call construction would leak if it gained state (fd handles, watchers).
    const hostResourcesFileStoreCache = new Map<string, ReturnType<typeof createFileStore>>();
    const hostResourcesResolver = new FileBackedHostResourcesResolver((wsId: string) => {
      // Files are workspace-owned: the resolver passes the bundle's request
      // workspace (`ctx.workspaceId`) so a `files://` read resolves there only.
      const userId = resolveRequestOwnerId(
        getRequestContext()?.identity,
        identityProvider !== null,
      );
      const cacheKey = `${wsId}:${userId}`;
      const cached = hostResourcesFileStoreCache.get(cacheKey);
      if (cached) return cached;
      const store = createFileStore(workspaceFilesDir(hostResourcesWorkDir, wsId, userId));
      hostResourcesFileStoreCache.set(cacheKey, store);
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

    // `maxInputTokens` is not composed at runtime startup — it's read
    // per-call from `this.config` in `chat()`. The per-call message budget
    // comes from the resolved
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
      //
      // Deliberately EXCLUDES personal connectors (which `availableTools` does
      // surface). A delegated child runs as the parent's exact identity, so a
      // granted personal connector IS in the child's reachable set — but it is
      // not in the child's *default* active set: a sub-agent gets one only when
      // the parent explicitly opts it in via a `granola__*` glob. That is
      // least-privilege for delegation, and it is a decision, not an accident —
      // do not add personal connectors here to "make the sets consistent."
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
      skillMatcher,
      config,
      contextSkills,
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

    // Register placements declared by platform sources.
    registerPlatformPlacements(placementRegistry, platformSources);

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

    // Seed lifecycle instances for workspace bundles.
    seedWorkspaceBundleInstances(
      lifecycle,
      workspaceRegistries,
      placementRegistry,
      workspaceBundleEntries,
    );

    // Reconcile connector-skill overlays to the pinned version. Overlays bind
    // only at connector install, and the pin is deploy-time config — so boot
    // (a restart) is exactly when a pin bump must reach connectors that are
    // already installed. Best-effort + version-gated: a no-op when nothing is
    // stale, so steady-state boots pay only a per-connector version comparison.
    await bootReconcileConnectorSkills({
      workDir: rt.getWorkDir(),
      listWorkspaces: () => workspaceStore.list(),
      updateWorkspaceBundles: (wsId, bundles) => workspaceStore.update(wsId, { bundles }),
      syncBoundSkills: (identity, serverName, wsId, wd) =>
        lifecycle.syncBoundSkills(identity, serverName, wsId, wd),
      catalogByIdMap: () => rt.getConnectorDirectory().catalogByIdMap(),
      catalogByUrl: () => rt.getConnectorDirectory().catalogByUrl(),
    });

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
    // `workspaceId` names the workspace this turn acts from. The HTTP chat door
    // REQUIRES it (`requireWorkspace` on `/v1/chat*`), so it's always present for
    // HTTP callers; the `?? personal` default below serves only embedded / dev /
    // CLI callers (and dev-mode requests, where the middleware passes through
    // without an identity) that drive the runtime directly without a header.
    // It's the conversation metadata breadcrumb here and is delegated to `chat()`
    // below, which re-resolves the same default for tool scope. (Pre-Stage-2 the
    // missing-workspace case hard-threw a raw 500 on chat-start; the default
    // keeps the embedded path working.)
    const wsId = request.workspaceId ?? personalWorkspaceIdFor(ownerId);
    const createOpts: CreateConversationOptions = {
      ownerId,
      workspaceId: wsId,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    // Resolve the conversation's workspace store: the conversation's own workspace on
    // resume (authoritative, from the locator), or the workspace it's born in
    // (`wsId`) for a new conversation. The workspace owns the directory.
    const { store, convWsId } = await this.resolveChatStore(request.conversationId, wsId, ownerId);

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
      // Second authz gate (resume): the owner must still be a member of the
      // conversation's workspace — runs before `begin`, so a removed member never
      // reserves a run. Mirrors the `chat()` path; reads stay owner-gated.
      if (existing) {
        await this.assertOwnerIsWorkspaceMember(request.conversationId, convWsId, ownerId);
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
    const sessionWsId = await this.prepareSessionWorkspace(requestIdentity);

    // The conversation's workspace — the binding, and the ONE workspace this
    // turn resolves against. A chat is born in the focused workspace
    // (`request.workspaceId`, REQUIRED on the HTTP chat door so it's always
    // present there), or the caller's personal workspace when absent — the
    // embedded / dev path only (`?? sessionWsId`) — and stays there for its
    // whole life. On resume the workspace
    // is read from the conversation's own path via the locator (authoritative),
    // NOT from the request header — so a conversation answered while you're
    // focused elsewhere still resolves its own tools, skills, apps, files, and
    // workspace context. The conversation is a sealed container; the focused
    // workspace only decides where a NEW chat is born.
    const requestWsId = request.workspaceId ?? sessionWsId;
    // `convWsId` is authoritative: on a cross-workspace resume `resolveChatStore`
    // relocates to the workspace the conversation actually lives in. Every
    // workspace-scoped surface below (`toolsWsId`, skills, apps, overlays, file
    // partition) keys off it, not the request header — otherwise a resumed chat
    // leaks the focused workspace's tools/context into another workspace's thread.
    const { store, convWsId } = await this.resolveChatStore(
      request.conversationId,
      requestWsId,
      ownerId,
    );
    // Narrate the conversation's OWN workspace — personal or shared alike. A
    // personal workspace is just a workspace (JIT-provisioned at login), so it's
    // named in the prompt like any other when the conversation lives there. A
    // sealed conversation narrates its own workspace from wherever it's viewed.
    // `formatNoWorkspaceContext()` (compose.ts) is reserved for genuinely
    // workspace-less contexts — an external `/mcp` call with no `X-Workspace-Id`;
    // the chat door requires a workspace, so it never reaches that branch.
    const narratedWsId = convWsId;

    // Load the personal workspace config for agents / models override.
    // Pre-Stage-2 this looked up the request's `workspaceId`; that field
    // is gone, and "override on the user's own workspace" is the natural
    // identity-bound semantic. Stage 6 may relocate this to a per-
    // conversation pin if multi-workspace overrides become a need.
    const sessionWorkspace = await this._workspaceStore.get(sessionWsId);

    const createOpts: CreateConversationOptions = {
      ownerId,
      // The conversation's workspace binding — the workspace it's born in (focused,
      // or personal when unfocused). Authoritative: the conversation is stored
      // under `workspaces/<workspaceId>/conversations/<ownerId>/`, and this is
      // fixed for its whole life (no mid-chat workspace switching).
      workspaceId: convWsId,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    // Resume an existing conversation only if the caller owns it (the ownerId
    // check is the ONLY barrier between users and each other's conversations —
    // it runs in the load-bearing chat path, not just at a higher layer), and
    // requires CURRENT membership of the conversation's workspace on resume.
    const conversation = await this.loadOrCreateConversation(
      request,
      store,
      createOpts,
      ownerId,
      convWsId,
    );

    // Build the user message (text + `resource_link` attachment blocks) and
    // append it to the conversation log.
    const userContent = buildUserMessageContent(request);
    await this.appendUserMessage(store, conversation, userContent, request);

    // Every workspace-scoped surface below — the skill pool, the briefing, the
    // tool set — keys off the conversation's own workspace (`convWsId`, resolved
    // above), so a resumed chat stays sealed to its workspace regardless of the
    // `/w/:slug` currently being viewed.

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
    const conversationPool = this.loadConversationSkills(convWsId, userId);
    const { context: poolContext, capability: poolCapability } =
      partitionSkillsByRole(conversationPool);
    const requestMatcher = new SkillMatcher();
    requestMatcher.load(poolCapability);
    const skill = requestMatcher.match(request.message);

    // The workspace BRIEFING (apps + workspace overlay + "## Workspace" block
    // + workspace persona) reflects the conversation's own workspace
    // (`narratedWsId` = `convWsId`) — personal or shared alike. Deterministic +
    // workspace-scoped (same for every member of that workspace).
    const { apps, liveOverlays } = await this.buildWorkspaceBriefing(narratedWsId);

    // Build focusedApp/appState/focusedNamespaced when the request is scoped to a
    // specific app (§7 app-aware chat), resolved in the SAME single workspace the
    // session's tools are bound to (`convWsId`).
    let focusedApp: FocusedAppInfo | undefined;
    let appState: AppStateInfo | undefined;
    let focusedNamespaced: string | undefined;
    if (request.appContext) {
      ({ focusedApp, appState, focusedNamespaced } = await this.resolveFocusedApp(
        request.appContext,
        convWsId,
      ));
    }

    // Tool surfacing. A session reaches exactly ONE workspace: the conversation's
    // own (`convWsId`). The ACTIVE set the model sees is that workspace's tools
    // (one copy of the platform `nb__*` tools + that workspace's apps) plus the
    // caller's identity tools. There is no cross-workspace union. `nb__search`'s
    // corpus (`listDiscoverableTools`) is this same workspace, so progressive
    // disclosure operates WITHIN the workspace (a workspace with more tools than
    // the active cap), not across workspaces. Role-based visibility
    // (`isToolVisibleToRole`) and surface-tier tiering (`surfaceTools`) apply to
    // this set. A conversation in the personal workspace uses it as the
    // workspace — the same silent bridge used for session reads.
    const toolsWsId = convWsId;
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
    // `focusedNamespaced` (the WORKSPACE-PREFIXED source name that
    // `surfaceTools.focusedServerName` matches) is computed in `resolveFocusedApp`.
    const { direct: tools, proxied } = surfaceTools(
      allTools,
      skill,
      buildSurfaceOptions(focusedNamespaced, request.allowedTools),
    );

    // Per-user preferences from the authenticated identity. We already
    // hard-error if no identity above, so reads here are unconditional.
    const prefs = buildPromptPrefs(requestIdentity);

    // The prompt narrates the conversation's own workspace — the same one whose
    // apps + house rules the briefing above describes — so the prose, the app
    // list, and the persona all agree. `narratedWsId` is always the
    // conversation's workspace (personal or shared), so this loads a real, named
    // workspace and compose always renders the "## Workspace" block.
    const activeWorkspace = await this._workspaceStore.get(narratedWsId);
    const workspaceContext = buildWorkspaceContext(narratedWsId, activeWorkspace);

    // Skill selection. Server-exposed `skill://<name>/SKILL.md` resources are
    // discovered here and routed by the strategy they DECLARE: `dynamic` ones
    // join tool-affinity Layer 3 (loading when the bundle's tools are surfaced,
    // no `appContext` scoping required); `always` ones (`bundleContext`) compose
    // into the always-on context channel below, the same reliable every-turn
    // path filesystem `always` skills use.
    //
    // Workspace-tier skills follow the conversation's own workspace (`convWsId`),
    // matching the briefing / apps / overlay surfaces. A conversation in the
    // personal workspace reads the identity's personal scope, consistent with
    // the rest of personal-workspace reads. Reuse the capability pool computed
    // for the per-request matcher above — same `wsId` and `userId` — so the
    // conversation-skill disk read happens once per turn, not twice.
    const { context: bundleContext, layer3: selectedLayer3 } = await this.selectRequestLayer3({
      wsId: convWsId,
      userId,
      activeToolNames: tools.map((t) => t.name),
      capabilityPool: poolCapability,
      ...(request.appContext?.serverName
        ? { appContextServerName: request.appContext.serverName }
        : {}),
    });

    // Always-on context channel: the `always` skills across every tier
    // (core/builtin/org + workspace + user) plus the always-on bundle skills,
    // then the workspace identity/persona override when the conversation's
    // workspace sets one.
    const requestContextSkills = withIdentityOverride(
      [...poolContext, ...bundleContext],
      activeWorkspace?.identity,
    );
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
    // Files are workspace-owned: rehydrate a `files://` URI from the
    // conversation's AUTHORITATIVE workspace (`convWsId` from `resolveChatStore`,
    // the same workspace the upload landed in) under the owner's partition —
    // never another workspace's store. On a cross-workspace resume this is the
    // conversation's workspace, not the request header — they differ, and reading
    // from the header would miss the attachment entirely.
    const fileStore = this.getWorkspaceFileStore(convWsId, ownerId);

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
    // The RAW (un-rehydrated) history the engine reasons about: the compacted
    // form when compaction fired, else the full history. Rehydration inlines
    // file bytes exactly once below; connector-injection detection reads this
    // un-rehydrated form (rehydrate strips the synthetic marker's metadata).
    const effectiveHistory = compactedHistory ?? history;
    const messages = await rehydrateUserResources(effectiveHistory, fileStore, {
      model: resolvedModelString,
      maxExtractedTextSize: this.getFilesConfig().maxExtractedTextSize,
    });

    // Per-request hooks: inherit `beforeToolCall` from the runtime-level hooks;
    // compose `transformContext` here so the windowing budget is the one we just
    // resolved for THIS call.
    const perRequestHooks: EngineHooks = {
      ...this.hooks,
      transformContext: buildTransformContext(
        messageBudget.budget,
        getProviderFromModel(resolvedModelString),
      ),
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

    const engineConfig = this.buildTurnEngineConfig({
      model: resolvedModelString,
      requestMaxIterations: request.maxIterations,
      maxInputTokens: messageBudget.budget,
      maxOutputTokens: resolvedMaxOutputTokens,
      thinking: resolvedThinking,
      hooks: perRequestHooks,
      skillsLoaded,
      contextAssembled,
      // Connector-skill overlays for the conversation's own workspace — surfaced
      // once into history by the engine on a matching connector tool call, never
      // into the system prefix. Same workspace scoping as the layer-3 pool.
      // Merge SEP-2640 bundle skills as candidates too, so a server's skill is
      // delivered mid-turn when its tools are progressively disclosed (promotion),
      // not only at turn-start via <layer3-skill> (which misses mid-turn promotion).
      connectorSkillCandidates: [
        ...this.loadConnectorSkillCandidates(convWsId),
        ...(await this.loadBundleSkillCandidates(convWsId, request.appContext?.serverName)),
      ],
      // From the UN-rehydrated history — this is what makes surface-ONCE hold
      // across turns on the real chat path.
      alreadyInjectedConnectorSkills: this.collectInjectedConnectorSkills(effectiveHistory),
      signal: request.signal,
    });

    // Conversations are workspace-owned: `store` (from `resolveChatStore`) is the
    // per-call workspace event store, and is both the active event sink for this
    // turn's engine events and a member of the per-request sink chain.
    store.setActiveConversation(conversation.id);

    // Build per-request sink chain. The engine itself returns cumulative
    // usage and llmMs in its EngineResult — no need for a side-channel
    // metrics collector.
    const sinks: EventSink[] = requestSink
      ? [requestSink, this.defaultEvents]
      : [this.defaultEvents];
    sinks.push(store);

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
      // The scope workspace is the session (personal) workspace — the same
      // breadcrumb the conversation metadata records. Per-call scope comes from
      // the routed namespace, not from `requireWorkspaceId()`.
      scope: buildWorkspaceScope(sessionWsId, sessionWorkspace),
      conversationId: conversation.id,
      // Files created/read by identity-door `files__*` tools land in the
      // conversation's authoritative workspace — the same partition the
      // rehydration read and the upload write use.
      fileWorkspaceId: convWsId,
    };
    engineConfig.toolPromotion = this.buildToolPromotionFactory();

    // Emit chat.start so the client knows the conversation ID immediately and
    // conversation list UIs can refresh.
    this.emitChatStart(requestSink, conversation.id, !request.conversationId);

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

    // The workspace event store persisted the engine events (including the
    // assistant turn) via emit() as they streamed, so there is no separate
    // assistant-message append here.

    // Fire-and-forget title generation on the first turn (decoupled from the
    // turn lifecycle; best-effort). Broadcasts `conversation.title` on the global
    // SSE — routed to the right conversation by `conversationId` — so delivery is
    // reliable after the turn ends and across tabs.
    this.maybeGenerateTitle(conversation, request, store, result.output, sessionWsId);

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

    // Provenance membership gate. An automation fires AS its owner, walled to its
    // provenance workspace (`request.workspaceId`). Membership there is validated
    // at create, NOT per run — so a since-removed owner would otherwise keep
    // acting in a workspace they left (its tools/connectors). Deny the run before
    // any setup or tool binding. Thrown early so the scheduler records it as a
    // skipped run (self-heals if the owner is re-added); personal workspaces are
    // sole-member, so they never gate.
    if (request.workspaceId && !(await this.isOwnerWorkspaceMember(request.workspaceId, ownerId))) {
      throw new WorkspaceMembershipRevokedError(ownerId, request.workspaceId);
    }

    // Session workspace (personal) — used for the silent dispatch reqCtx,
    // file store, and the workspace-agents / model overrides lookup. Never
    // narrated by the task prompt; the prompt only mentions the focused
    // workspace if one is set.
    const sessionWsId = await this.prepareSessionWorkspace(requestIdentity);
    // A task is a one-shot run, not a conversation: it produces a deliverable
    // (the caller — the automations bundle — persists the run result), so
    // nothing is written to a conversation store and there is no resume path.
    // `runId` is the run's traceability anchor: stamped on the request context
    // for audit/file correlation and returned to the caller as the id under
    // which it persists the result.
    const runId = `run_${crypto.randomUUID().slice(0, 12)}`;
    const sessionWorkspace = await this._workspaceStore.get(sessionWsId);

    // Workspace briefing (apps + overlays + workspace context). Same shape
    // as chat: gated on `focusedWsId`. When absent the briefing layers are
    // empty and `TASK_IDENTITY` is the dominant framing.
    const focusedWsId = request.workspaceId;
    const { apps, liveOverlays } = await this.buildWorkspaceBriefing(focusedWsId);

    // The task's single working workspace: the focused workspace, or the personal
    // (session) workspace when unfocused. Tool scope, skill/bundle scope,
    // connector overlays, and file provenance all key off this one id.
    const workWsId = focusedWsId ?? sessionWsId;

    // Tool surfacing. The task is walled to one workspace: active set = the
    // focused workspace's tools (or the session/personal workspace if no focus)
    // + identity tools. `nb__search`'s corpus is that same workspace — no
    // cross-workspace reach.
    const toolsRegistry = await this.ensureWorkspaceRegistry(workWsId);
    const [focusedTools, identityTools] = await Promise.all([
      toolsRegistry.availableTools(),
      this.listIdentitySourceTools(),
    ]);
    const allTools: ToolSchema[] = [
      ...focusedTools
        .filter((t) => isToolVisibleToRole(t.name, requestIdentity.orgRole))
        .map((t) => ({
          name: namespacedToolName(workWsId, t.name),
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
    const { direct: tools, proxied } = surfaceTools(
      allTools,
      null,
      buildSurfaceOptions(undefined, request.allowedTools),
    );

    const prefs = buildPromptPrefs(requestIdentity);

    const activeWorkspace = await this.resolveTaskActiveWorkspace(
      focusedWsId,
      sessionWsId,
      sessionWorkspace,
    );
    const workspaceContext = buildWorkspaceContext(focusedWsId, activeWorkspace);

    // Layer 3 selection — bundle workflow guidance still applies based on
    // the active tool set. No `appContextServerName` (tasks don't have
    // appContext).
    //
    // Workspace-tier skills follow the FOCUSED workspace, falling back
    // to the session (personal) workspace only when the task has no
    // focus. This mirrors `_chatInner`; tasks scheduled against a shared
    // workspace were silently dropping every `loading_strategy: always` skill
    // in that workspace before this parity fix.
    const userId = requestIdentity.id;
    // Partition by role (same as `_chatInner`): context → Layer 0/1; capability
    // → conditional Layer 3. Disjoint by `type`, so no skill injects twice.
    const conversationPool = this.loadConversationSkills(workWsId, userId);
    const { context: poolContext, capability: poolCapability } =
      partitionSkillsByRole(conversationPool);
    // Discover + route the FOCUSED workspace's bundle skills by declared strategy
    // (the wall — never across the owner's other workspaces). `always` bundle
    // skills land in `bundleContext` (context channel every turn); `dynamic` ones
    // feed tool-affinity Layer 3. Mirrors `_chatInner`.
    const { context: bundleContext, layer3: selectedLayer3 } = await this.selectRequestLayer3({
      wsId: workWsId,
      userId,
      activeToolNames: tools.map((t) => t.name),
      capabilityPool: poolCapability,
    });
    // Always-on context channel (conversation-tier + always-on bundle skills)
    // plus the workspace identity/persona override when the focused workspace
    // sets one.
    const requestContextSkills = withIdentityOverride(
      [...poolContext, ...bundleContext],
      activeWorkspace?.identity,
    );
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
    const resolvedModelString = this.resolveRequestModelString(request.model);

    // The task's single input message — no conversation, no history, no resume.
    // Rehydration below is a pass-through for shape consistency with the engine's
    // message contract (it only does work if the prompt carries file refs). The
    // file store is anchored to the run's provenance workspace (`workWsId` — the
    // request workspace, or the owner's personal workspace when unfocused).
    const fileStore = this.getWorkspaceFileStore(workWsId, ownerId);
    const taskMessages: StoredMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: request.prompt }],
        timestamp: new Date().toISOString(),
        userId: requestIdentity.id,
      },
    ];

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

    // No compaction: a task has a single-message history, never near budget.
    const messages = await rehydrateUserResources(taskMessages, fileStore, {
      model: resolvedModelString,
      maxExtractedTextSize: this.getFilesConfig().maxExtractedTextSize,
    });

    const perRequestHooks: EngineHooks = {
      ...this.hooks,
      transformContext: buildTransformContext(
        messageBudget.budget,
        getProviderFromModel(resolvedModelString),
      ),
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

    const engineConfig = this.buildTurnEngineConfig({
      model: resolvedModelString,
      requestMaxIterations: request.maxIterations,
      maxInputTokens: messageBudget.budget,
      maxOutputTokens: resolvedMaxOutputTokens,
      thinking: resolvedThinking,
      hooks: perRequestHooks,
      skillsLoaded,
      contextAssembled,
      // Connector-skill overlays — same focused-workspace scoping as the
      // layer-3 pool; surfaced once into history, never the system prefix.
      // Bundle skills (SEP-2640) join as candidates so a promoted server's skill
      // surfaces mid-turn, not only at turn-start. Tasks carry no appContext.
      connectorSkillCandidates: [
        ...this.loadConnectorSkillCandidates(workWsId),
        ...(await this.loadBundleSkillCandidates(workWsId)),
      ],
      // A fresh task has a single user message and no prior history, so no
      // connector skill has been injected yet — the set is empty.
      alreadyInjectedConnectorSkills: this.collectInjectedConnectorSkills(taskMessages),
      signal: request.signal,
    });

    // No conversation store: a task run isn't persisted as a chat. The sinks are
    // the optional per-request sink, the default telemetry events, and the usage
    // accumulator below.
    const sinks: EventSink[] = requestSink
      ? [requestSink, this.defaultEvents]
      : [this.defaultEvents];

    // Per-run usage accumulator. The engine returns its cumulative usage only
    // on a clean exit; on an abort it throws and discards it (engine.ts run.error
    // path). But `executeTask`'s contract (see `TaskResult` docstring) promises a
    // result on completion "including timeout" — silent abandonment is the worst
    // failure mode. So we mirror the engine's per-call accounting from the events
    // it emits (same llm.done/tool.done shape PostHogEventSink reads) and retain
    // it across the throw, letting a timed-out automation report the work it
    // actually did instead of 0/0/0/0. Drops with the process — a real SIGKILL
    // still reports zero (the persisted run result is the post-mortem).
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
      workspaceId: workWsId,
      perCallWorkspaceMap,
    });
    const engine = new AgentEngine(resolvedModel, identityToolRouter, engineSink);

    const reqCtx: RequestContext = {
      identity: requestIdentity,
      // The scope workspace is the session (personal) workspace, carrying its
      // agents + model overrides.
      scope: buildWorkspaceScope(sessionWsId, sessionWorkspace),
      // The run's correlation id (no conversation exists) — stamps audit/file
      // records so a file the run creates is traceable back to it.
      conversationId: runId,
      // Files created/read by identity-door `files__*` tools land in the run's
      // provenance workspace (`workWsId`) — the same partition the rehydration
      // read uses, not the personal `sessionWsId` scope.
      fileWorkspaceId: workWsId,
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
        runId,
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

    // No conversation to persist — the deliverable (output), the activity log
    // (toolCalls), and the usage are returned to the caller, which persists the
    // run result. Nothing is written to a conversation store.
    return {
      output: result.output,
      runId,
      toolCalls: result.toolCalls,
      stopReason: result.stopReason,
      usage,
    };
  }

  // ── chat / task turn helpers (shared setup) ──────────────────────

  /**
   * Ensure the identity's personal (session) workspace exists and has a
   * registry, returning its id. Idempotent belt-and-suspenders for embedded /
   * dev / CLI callers that never went through HTTP auth.
   */
  private async prepareSessionWorkspace(identity: UserIdentity): Promise<string> {
    const sessionWsId = personalWorkspaceIdFor(identity.id);
    await ensureUserWorkspace(this._workspaceStore, {
      id: identity.id,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
    });
    await this.ensureWorkspaceRegistry(sessionWsId);
    return sessionWsId;
  }

  /**
   * Resolve the request model string: apply an `alias:` slot indirection, then
   * qualify the bare id. Qualification at the request-entry boundary lets the
   * rest of the pipeline (cost aggregation, capability checks, resolvers, log
   * lines) read `engineConfig.model` and depend on it being qualified.
   */
  private resolveRequestModelString(requestModel: string | undefined): string {
    let modelString = requestModel ?? this.getDefaultModel();
    const aliasSlot = parseAliasRef(modelString);
    if (aliasSlot) {
      modelString = this.getModelSlot(aliasSlot);
    }
    return resolveModelString(modelString);
  }

  /**
   * The workspace briefing surfaces (apps + org/workspace overlays) for a turn.
   * `wsId` is the conversation's own (chat) or focused (task) workspace;
   * `undefined` (personal/session) yields empty apps and org-only overlays.
   */
  private async buildWorkspaceBriefing(wsId: string | undefined): Promise<{
    apps: PromptAppInfo[];
    liveOverlays: { org: string; workspace: string };
  }> {
    const apps = wsId ? await this.buildAppsList(wsId) : [];
    // Org overlay always applies (org-level, not workspace-specific); the
    // workspace overlay only for a real (non-personal) workspace.
    const liveOverlays = wsId
      ? await this.readPromptOverlays(wsId)
      : { org: await this.getInstructionsStore().read({ scope: "org" }), workspace: "" };
    return { apps, liveOverlays };
  }

  /**
   * Resolve (owning) or create the conversation for a chat turn.
   *
   * Enforces the ownerId privacy gate and the resume workspace-membership gate
   * in the same order as the inline path, and preserves request metadata onto a
   * resumed conversation. The disambiguation between "doesn't exist" (→ create)
   * and "exists but isn't yours" (→ throw) matters: silently creating a new
   * conversation for a foreign id would mask a takeover attempt as a normal flow.
   */
  private async loadOrCreateConversation(
    request: ChatRequest,
    store: EventSourcedConversationStore,
    createOpts: CreateConversationOptions,
    ownerId: string,
    convWsId: string,
  ): Promise<Conversation> {
    let conversation: Conversation;
    if (request.conversationId) {
      const existing = await store.load(request.conversationId);
      if (existing && existing.ownerId !== ownerId) {
        throw new ConversationAccessDeniedError(request.conversationId, ownerId);
      }
      // Resume requires CURRENT membership of the conversation's workspace — not
      // just ownership. Resuming binds tools/skills/apps to `convWsId`, so a
      // member offboarded from that workspace must not be able to continue acting
      // in it (reads stay owner-gated). New conversations skip this: `convWsId` is
      // the focused workspace, already membership-validated at the door.
      if (existing) {
        await this.assertOwnerIsWorkspaceMember(request.conversationId, convWsId, ownerId);
      }
      conversation = existing ?? (await store.create(createOpts));
    } else {
      conversation = await store.create(createOpts);
    }

    // Preserve metadata on resumed conversations (don't overwrite).
    if (request.metadata && !conversation.metadata) {
      conversation.metadata = request.metadata;
    }
    return conversation;
  }

  /**
   * Resolve the focused-app briefing (§7 app-aware chat) for a request scoped to
   * a specific app: the app descriptor, its bound workspace, the LLM-aware app
   * state (Synapse Feature 2), and the workspace-prefixed source name used to
   * match surfaced tools. Returns empties when the app's source isn't running
   * (or crashed mid-turn) — the wall applies to the briefing too: it can only
   * ever describe an app whose tools this session is allowed to call.
   */
  private async resolveFocusedApp(
    appContext: NonNullable<ChatRequest["appContext"]>,
    convWsId: string,
  ): Promise<{
    focusedApp?: FocusedAppInfo;
    focusedAppWsId?: string;
    appState?: AppStateInfo;
    focusedNamespaced?: string;
  }> {
    // The app is resolved in the SAME single workspace the session's tools are
    // bound to (`convWsId`), never a scan across the identity's other workspaces.
    const appWsId = convWsId;
    const reg = this._workspaceRegistries.get(appWsId);
    const source = reg?.getSources().find((s) => s.name === appContext.serverName);
    if (!source) return {};

    let focusedApp: FocusedAppInfo;
    try {
      const sourceTools = await source.tools();
      // Primary = the first skill this source lists (resources/list order). For a
      // multi-skill server, only this primary reaches the focused-app briefing:
      // loadBundleSkills skips the entered source (dedup), so its other skills don't
      // surface via Layer-3 while entered. (No server publishes 2+ skills today.)
      const [primarySkill] = await this.discoverServerSkills(appContext.serverName);
      const skillResource = primarySkill?.body ?? null;
      // Companion reference lives beside the skill (SEP-2640 supporting files share
      // the skill's path), derived from the DISCOVERED URI — never from the source
      // name, whose reverse-DNS slug won't match the skill's short path.
      const referenceUri = primarySkill?.uri.replace(/\/SKILL\.md$/, "/reference");
      const hasReference =
        referenceUri && source instanceof McpSource
          ? await this.hasResource(source, referenceUri)
          : false;
      const bundleInstance = this.lifecycle?.getInstance(appContext.serverName, appWsId);
      focusedApp = {
        name: appContext.appName,
        tools: sourceTools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
        ...(skillResource ? { skillResource } : {}),
        ...(hasReference && referenceUri ? { referenceResourceUri: referenceUri } : {}),
        trustScore: bundleInstance?.trustScore ?? 100,
      };
    } catch {
      // Source stopped or crashed — no app briefing this turn.
      return {};
    }

    // appState (LLM-aware UI state) only when the request carries it; the app
    // has already resolved past the guards above.
    const appState: AppStateInfo | undefined = appContext.appState
      ? {
          state: appContext.appState.state,
          summary: appContext.appState.summary,
          updatedAt: appContext.appState.updatedAt,
          trustScore:
            this.lifecycle?.getInstance(appContext.serverName, appWsId)?.trustScore ?? 100,
        }
      : undefined;

    // The focused-app match key is the WORKSPACE-PREFIXED source name: tools land
    // in the active list as `ws_<id>-<source>__<tool>`, and
    // `surfaceTools.focusedServerName` matches with `t.name.startsWith(prefix + "__")`.
    // Build via the namespace primitive (single legal construction site for
    // `ws_<id>-<...>` per `check:tool-namespace`).
    const focusedNamespaced = namespacedToolName(appWsId, appContext.serverName);

    return { focusedApp, focusedAppWsId: appWsId, appState, focusedNamespaced };
  }

  /** Append the turn's user message (content + optional userId + file metadata) to the store. */
  private async appendUserMessage(
    store: EventSourcedConversationStore,
    conversation: Conversation,
    content: Array<UserTextPart | UserResourceLinkPart>,
    request: ChatRequest,
  ): Promise<void> {
    await store.append(conversation, {
      role: "user",
      content,
      timestamp: new Date().toISOString(),
      ...(request.identity?.id ? { userId: request.identity.id } : {}),
      ...(request.fileRefs?.length ? { metadata: { files: request.fileRefs } } : {}),
    });
  }

  /**
   * Emit the initial `chat.start` (so the client knows the conversation id
   * immediately) and, for a new conversation, a conversations-list `data.changed`
   * — both on the per-request sink only.
   */
  private emitChatStart(
    requestSink: EventSink | undefined,
    conversationId: string,
    isNewConversation: boolean,
  ): void {
    if (!requestSink) return;
    requestSink.emit({ type: "chat.start", data: { conversationId } });
    // Notify conversation browser UIs that a new conversation exists.
    if (isNewConversation) {
      requestSink.emit({ type: "data.changed", data: { server: "conversations", tool: "list" } });
    }
  }

  /**
   * Fire-and-forget first-turn title generation (on the `fast` slot). Persists
   * the title + its aux usage and broadcasts `conversation.title` on the global
   * SSE. Best-effort — a failure only logs.
   *
   * `wsId: sessionWsId` (the owner's personal workspace) — NOT
   * `conversation.workspaceId`: the SSE layer scopes `scope: "workspace"` events
   * to clients whose membership set contains this wsId. Conversations are
   * owner-scoped and the owner is always a member of their own personal
   * workspace, so this reaches exactly the owner's tabs. (The iframe list patch
   * routes by `conversationId`, unaffected either way.)
   */
  private maybeGenerateTitle(
    conversation: Conversation,
    request: ChatRequest,
    store: EventSourcedConversationStore,
    output: string,
    sessionWsId: string,
  ): void {
    if (conversation.title !== null) return;
    const titleSlot = this.getModelSlot("fast");
    const titleModel = this.resolveModelFn(titleSlot);
    const titleInput =
      request.message ||
      `[Uploaded: ${request.fileRefs?.map((f) => f.filename).join(", ") || "files"}]`;
    // The title call runs the `fast` slot outside the agentic loop; persist its
    // usage as an aux.usage event so it isn't invisible to cost accounting.
    const appendTitleUsage = store.appendEvent?.bind(store);
    void generateTitle(titleModel, titleInput, output, (usage, llmMs) => {
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
        this.defaultEvents.emit({
          type: "conversation.title",
          data: { conversationId: conversation.id, title, wsId: sessionWsId },
        });
      })
      .catch((err) => {
        // Title generation is best-effort; a failed write must not crash the chat
        // (model latency timeout, or ENOENT if the conversation was deleted).
        log.error("[runtime] title generation failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** Assemble the per-turn `EngineConfig` (present-only `thinking` / `signal`; `toolPromotion` is set by the caller). */
  private buildTurnEngineConfig(opts: {
    model: string;
    requestMaxIterations: number | undefined;
    maxInputTokens: number;
    maxOutputTokens: number;
    thinking: EngineConfig["thinking"];
    hooks: EngineHooks;
    skillsLoaded: SkillsLoadedPayload;
    contextAssembled: ContextAssembledPayload;
    connectorSkillCandidates: EngineConfig["connectorSkillCandidates"];
    alreadyInjectedConnectorSkills: EngineConfig["alreadyInjectedConnectorSkills"];
    signal: AbortSignal | undefined;
  }): EngineConfig {
    return {
      model: opts.model,
      maxIterations:
        opts.requestMaxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      // Surfaced on run.start telemetry; the actual budget enforcement happens
      // inside `hooks.transformContext`.
      maxInputTokens: opts.maxInputTokens,
      maxOutputTokens: opts.maxOutputTokens,
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      maxToolResultSize: this.config.maxToolResultSize,
      hooks: opts.hooks,
      runMetadata: {
        skillsLoaded: opts.skillsLoaded,
        contextAssembled: opts.contextAssembled,
      },
      connectorSkillCandidates: opts.connectorSkillCandidates,
      alreadyInjectedConnectorSkills: opts.alreadyInjectedConnectorSkills,
      // Cancellation: thread the caller's signal into the engine, which checks it
      // between iterations and forwards it down to every tool call.
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
  }

  /**
   * The focused workspace record for a task run: the already-loaded session
   * workspace when the task is focused on it, a fresh load for any other focused
   * workspace, or `null` for an unfocused task.
   */
  private async resolveTaskActiveWorkspace(
    focusedWsId: string | undefined,
    sessionWsId: string,
    sessionWorkspace: Workspace | null,
  ): Promise<Workspace | null> {
    if (!focusedWsId) return null;
    if (focusedWsId === sessionWsId) return sessionWorkspace;
    return this._workspaceStore.get(focusedWsId);
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
        const id =
          (event.type === "tool.progress" || event.type === "tool.done") &&
          typeof event.data.id === "string"
            ? event.data.id
            : undefined;
        const wsId = id ? perCallWorkspaceMap.get(id) : undefined;
        if (!id || wsId === undefined) {
          inner.emit(event);
          return;
        }
        // Done is terminal — drop the entry now to keep the map bounded
        // across long-running conversations.
        if (event.type === "tool.done") perCallWorkspaceMap.delete(id);
        inner.emit({ type: event.type, data: { ...event.data, workspaceId: wsId } });
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
   * Discover the skills an MCP server exposes, parsed and truncated, with
   * caching. Per SEP-2640 (`io.modelcontextprotocol/skills`) a skill is a
   * `skill://<name>/SKILL.md` markdown resource; the runtime lists the source's
   * resources (`resources/list`) and reads the ones whose URI is a skill
   * entrypoint — it never guesses the URI from the source name (that guess,
   * `skill://<serverName>/usage`, missed every fleet connector whose name is a
   * reverse-DNS slug).
   *
   * Empty results (no skill resources, source not MCP, transport error) are
   * cached — the common case is "this server has no skills," and re-listing on
   * every chat over a stable source set would N×-multiply the request-path
   * latency.
   *
   * `SharedSourceRef`-wrapped sources are unwrapped before the `McpSource`
   * check; shared sources arrive wrapped and would otherwise be silently
   * invisible to this path.
   */
  private async discoverServerSkills(serverName: string): Promise<DiscoveredSkill[]> {
    const cached = this.skillResourceCache.get(serverName);
    if (cached && Date.now() - cached.fetchedAt < Runtime.SKILL_CACHE_TTL) {
      return cached.skills;
    }

    // Search across all workspace registries for the source.
    let source: ToolSource | undefined;
    for (const reg of this._workspaceRegistries.values()) {
      source = reg.getSources().find((s) => s.name === serverName);
      if (source) break;
    }
    const unwrapped = source instanceof SharedSourceRef ? source.unwrap() : source;
    if (!(unwrapped instanceof McpSource)) {
      this.skillResourceCache.set(serverName, { skills: [], fetchedAt: Date.now() });
      return [];
    }

    const skills: DiscoveredSkill[] = [];
    const { resources, ok } = await unwrapped.listResources();
    for (const resource of resources) {
      const skill = await this.readSkillResource(unwrapped, resource.uri);
      if (skill) skills.push(skill);
    }
    // Cache only a COMPLETE enumeration: a transport error mid-`resources/list`
    // (`ok: false`) leaves a partial result, and pinning it empty for the 5-minute
    // TTL would keep the skill dark after the transport recovers. Retry next turn.
    if (ok) {
      this.skillResourceCache.set(serverName, { skills, fetchedAt: Date.now() });
    }
    return skills;
  }

  /** Read one skill entrypoint resource into a parsed, budget-capped `DiscoveredSkill`, or `undefined` when the URI isn't a skill entrypoint or the resource is unreadable/empty. */
  private async readSkillResource(
    source: McpSource,
    uri: string,
  ): Promise<DiscoveredSkill | undefined> {
    if (!isSkillEntrypointUri(uri)) return undefined;
    let text: string | undefined;
    try {
      text = (await source.readResource(uri))?.text;
    } catch {
      // A single unreadable skill resource must not sink the whole discovery.
      return undefined;
    }
    if (!text) return undefined;
    const parsed = parseSkillMarkdown(uri, text);
    // Token budget: cap the body (heading-aware, so a trailing "rules"
    // section isn't sliced mid-rule — a production tool-selection failure).
    const capped = truncateMarkdownToBudget(parsed.body, MAX_SKILL_BODY_CHARS);
    if (capped.truncated) {
      log.warn(
        `[skill] server skill truncated to ${MAX_SKILL_BODY_CHARS} chars (${capped.sectionsOmitted} section(s) omitted) — ${uri}`,
      );
    }
    return {
      uri,
      name: parsed.name,
      description: parsed.description,
      body: capped.body,
      // Preserve the strategy the server declared (undefined = opted out;
      // synthesis defaults it to `dynamic`).
      ...(parsed.loadingStrategy ? { loadingStrategy: parsed.loadingStrategy } : {}),
      ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
    };
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
   * Discover every MCP source in `wsId`'s registry that exposes SEP-2640
   * `skill://<name>/SKILL.md` resources and synthesize a `Skill` for each,
   * honoring the loading strategy the skill declares in its frontmatter. A
   * `dynamic` skill (the default when none is declared) tool-affines to
   * `<serverName>__*` and loads via `selectLayer3Skills` whenever the server's
   * tools are in the active toolset; an `always` skill routes to the context
   * channel. Callers partition the returned pool by role (see
   * `selectRequestLayer3`) — no `appContext` required.
   *
   * Use case: a workspace-level chat where the model needs the server's
   * workflow guidance but isn't "entered" into the app. Without this, the
   * skill lived only on the `appContext`-scoped `<app-guide>` path and was
   * invisible to cross-server chats.
   *
   * Discovery reuses `discoverServerSkills`'s 5-minute cache, so this stays
   * cheap on warm requests. Per-source errors are swallowed (no skill resource
   * is the normal not-published case).
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
    // Servers with a materialized connector overlay: skip synthesizing their
    // `skill://…/SKILL.md` guidance — the curated overlay supersedes it (and
    // would otherwise double the guidance under two framings). A server "has an
    // overlay" iff its persisted ref carries a non-empty `skillsLock`.
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

    // Parallel discovery: serial probing N-times-multiplied the chat hot-path
    // latency on workspaces with many non-skill servers. `discoverServerSkills`
    // caches both positive and empty results so steady-state cost is zero. A
    // server may expose more than one skill, so each candidate yields 0..N.
    const synthesized = await Promise.all(
      candidates.map(async (name) => {
        try {
          const skills = await this.discoverServerSkills(name);
          return skills.map((s) =>
            synthesizeBundleSkill({
              serverName: name,
              skillName: s.name,
              description: s.description,
              body: s.body,
              uri: s.uri,
              ...(s.loadingStrategy ? { loadingStrategy: s.loadingStrategy } : {}),
              ...(s.priority !== undefined ? { priority: s.priority } : {}),
            }),
          );
        } catch {
          return [];
        }
      }),
    );
    return synthesized.flat();
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
      apps.push(await this.buildAppInfo(instance, registry));
    }
    return apps;
  }

  /**
   * Assemble one app's system-prompt entry: trust score, UI descriptor, the MCP
   * server's `initialize.instructions`, and the optional `app://instructions`
   * custom-instructions overlay.
   */
  private async buildAppInfo(
    instance: BundleInstance,
    registry: ToolRegistry | undefined,
  ): Promise<PromptAppInfo> {
    const trustScore = instance.trustScore ?? 0;
    const ui: PromptAppInfo["ui"] = instance.ui ? { name: instance.ui.name } : null;

    // Surface the MCP server's `initialize.instructions` (when set) so the
    // LLM sees per-bundle guidance — typically a pointer to `skill://`
    // resources that explain correct tool usage. Without this hint the
    // agent cannot discover that such resources exist.
    let instructions: string | undefined;
    let customInstructions: string | undefined;
    const source = registry?.getSource(instance.serverName);
    if (source instanceof McpSource) {
      instructions = source.getInstructions();
      customInstructions = await this.readAppCustomInstructions(source, instance.serverName);
    }

    return {
      name: instance.serverName,
      description: instance.description,
      instructions,
      ...(customInstructions !== undefined ? { customInstructions } : {}),
      trustScore,
      ui,
    };
  }

  /**
   * Read a bundle's `app://instructions` custom-instructions overlay. Returns
   * the trimmed non-empty body, or `undefined` when the bundle doesn't publish
   * the resource (or the read errors) — the normal not-supported case.
   */
  private async readAppCustomInstructions(
    source: McpSource,
    serverName: string,
  ): Promise<string | undefined> {
    // Reserved platform convention: `app://instructions`. A bundle that
    // supports user-set custom instructions publishes its current overlay
    // body at this URI; the platform reads it on every assembly and renders
    // it inside `<app-custom-instructions>` containment in `formatAppsSection`.
    //
    // Why `app://` over `<serverName>://instructions`: the serverName is
    // platform-derived (e.g. `@nimblebraininc/synapse-collateral` →
    // `synapse-collateral`), not something a bundle author intuitively knows.
    // A fixed scheme means bundle authors just remember `app://instructions`
    // and the platform's name-derivation rules are not part of the contract.
    //
    // Resource-not-found returns `null` from `readResource` (the SDK's normal
    // not-found path); we treat any read error or empty body as "bundle does
    // not support / has none". Plain MCP servers (no opt-in) end up here.
    try {
      const data = await source.readResource("app://instructions");
      const body = data?.text;
      const trimmedLen = typeof body === "string" ? body.trim().length : 0;
      // Visible under NB_DEBUG=mcp — confirms the platform fetched
      // app://instructions per active bundle and shows the resulting body
      // length. "len=0" + "set=false" for bundles that don't publish;
      // "set=true" + len=N for bundles that do.
      log.debug(
        "mcp",
        `app-instructions source=${serverName} fetched=${data !== null} len=${trimmedLen} set=${trimmedLen > 0}`,
      );
      if (typeof body === "string" && body.trim().length > 0) return body;
      return undefined;
    } catch (err) {
      log.debug(
        "mcp",
        `app-instructions source=${serverName} error=${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
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
   * Resolve a user's personal connector to a started `ToolSource`, lazy-starting
   * it on first use (see `BundleLifecycleManager.getIdentityConnectorSource`).
   * The DYNAMIC, per-identity connector door — deliberately separate from the
   * static kernel `getIdentitySource(name)` above: keyed by `(userId, name)`, it
   * resolves an MCP-backed personal connector, not a kernel source. Returns
   * `undefined` when the user has no such connector installed.
   */
  async getIdentityConnectorSource(userId: string, name: string): Promise<ToolSource | undefined> {
    return this.lifecycle.getIdentityConnectorSource(userId, name, this.getWorkDir());
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
   * The workspace-owned file store for one owner in one workspace
   * (`workspaces/<wsId>/files/<ownerId>/`). Files are workspace-owned, so the
   * workspace is the boundary: this is the single sanctioned `FileStore`
   * constructor outside the store module itself — `check:file-paths` rejects the
   * identity-scoped files dir. Cheap (closures over a path); not memoized here
   * because callers are per-request.
   */
  getWorkspaceFileStore(wsId: string, ownerId: string): FileStore {
    const store = createFileStore(workspaceFilesDir(resolveWorkDir(this.config), wsId, ownerId));
    // Keep the file locator's `fileId → wsId` memo current at the write sites,
    // where the workspace is known — so a freshly uploaded file serves O(1) and
    // a deleted one is forgotten. The locator stays correct without these (a
    // cold miss walks disk); they just keep the hot path hot.
    const locator = this.getFileLocator();
    return {
      ...store,
      saveFile: async (data, filename, mimeType) => {
        const result = await store.saveFile(data, filename, mimeType);
        locator.remember(ownerId, result.id, wsId);
        return result;
      },
      deleteFile: async (id) => {
        await store.deleteFile(id);
        locator.forget(ownerId, id);
      },
    };
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
    return this.listToolsForWorkspace(wsId, ctx?.identity?.id);
  }

  /**
   * The walled tool surface for a session bounded to `wsId`: that workspace's
   * tools (namespaced `ws_<id>-<tool>`) plus the caller's identity tools (bare),
   * plus — when `identityId` is given — the caller's personal connectors granted
   * to `wsId` (bare; any workspace, including the caller's own personal one, §
   * `_listGrantedPersonalConnectorTools`). The engine's reachable universe
   * (`IdentityToolRouter.availableTools`), the `nb__search` corpus
   * (`listDiscoverableTools`), and `/mcp` `tools/list` all read this — a session
   * reaches exactly one workspace, its own identity tools, and its granted
   * personal connectors.
   */
  async listToolsForWorkspace(wsId: string, identityId?: string): Promise<ToolSchema[]> {
    const registry = await this.ensureWorkspaceRegistry(wsId);
    const [wsTools, identityTools, personalTools] = await Promise.all([
      registry.availableTools(),
      this.listIdentitySourceTools(),
      identityId ? this._listGrantedPersonalConnectorTools(identityId, wsId) : Promise.resolve([]),
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
      ...personalTools,
    ];
  }

  /**
   * The caller's personal connectors granted into the session's workspace
   * `sessionWsId`, as bare `<connector>__<tool>` schemas — the identity-door form
   * `routeIdentityCall` dispatches (never namespaced, so they never hit the
   * workspace wall). Uniform across every workspace (a personal workspace is just
   * a workspace, with no special "own home" surfacing): only connectors the owner
   * granted to THIS workspace surface (deny by default), and only their
   * non-`disallow`ed tools.
   *
   * Each granted connector is resolved from the identity holder
   * (`getIdentityConnectorSource`, lazy-starting on first use); its tools are
   * enumerated here. Fail-safe: a connector that can't start surfaces nothing
   * rather than breaking the whole tool list (mirrors the per-source containment
   * in `ToolRegistry.availableTools`).
   */
  private async _listGrantedPersonalConnectorTools(
    identityId: string,
    sessionWsId: string,
  ): Promise<ToolSchema[]> {
    try {
      const granted = await this.getPermissionStore().connectorsGrantedTo(identityId, sessionWsId);
      if (granted.length === 0) return [];
      const tools: ToolSchema[] = [];
      for (const serverName of granted) {
        try {
          const source = await this.getIdentityConnectorSource(identityId, serverName);
          if (source) tools.push(...(await source.tools()));
        } catch (err) {
          log.debug(
            "mcp",
            `[runtime] personal-connector surfacing: skipping "${serverName}" for "${identityId}" — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return await this._filterSurfacedConnectorTools(tools, identityId);
    } catch (err) {
      log.debug(
        "mcp",
        `[runtime] personal-connector surfacing: skipping for "${identityId}" in "${sessionWsId}" — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /**
   * Keep the personal-connector tools that are NOT `disallow`ed by the owner.
   * **Surface = dispatchable:** the disallow read is the SAME `{scope:"user"}`
   * policy the identity-door gate enforces (per-connector, read once), so we
   * never advertise a tool that would then be denied. Kernel-source names are
   * excluded (they can't be shadowed). Input `tools` are already limited to
   * granted connectors by the caller.
   */
  private async _filterSurfacedConnectorTools(
    tools: readonly ToolSchema[],
    identityId: string,
  ): Promise<ToolSchema[]> {
    const store = this.getPermissionStore();
    const owner: PermissionOwner = { scope: "user", userId: identityId };
    const policyByConnector = new Map<string, Record<string, "allow" | "disallow">>();
    const out: ToolSchema[] = [];
    for (const t of tools) {
      const sep = t.name.indexOf("__");
      const source = sep > 0 ? t.name.slice(0, sep) : t.name;
      if (isIdentitySource(source)) continue;
      let policies = policyByConnector.get(source);
      if (!policies) {
        policies = await store.getConnector(owner, source);
        policyByConnector.set(source, policies);
      }
      const bare = sep > 0 ? t.name.slice(sep + 2) : t.name;
      if (isDisallowed(policies[bare])) continue;
      out.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
      });
    }
    return out;
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
   * Process-wide conversation locator: resolves a `convId` to the workspace +
   * owner it's stored under, and serves the cross-workspace (All-workspaces) and
   * workspace-scoped list views. Lazily built over the workspaces root; invalidated
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
   * Process-wide file locator: resolves a globally-unique `fileId` to the
   * workspace it lives under, within the caller's own owner partitions. Backs
   * the bare `GET /v1/files/:fileId` serve path (a browser `<img>` GET can't send
   * `X-Workspace-Id`, so the workspace can't ride the request — the id alone
   * resolves it). Lazily built; its memo is kept current by `getWorkspaceFileStore`.
   */
  getFileLocator(): FileLocator {
    if (!this._fileLocator) {
      this._fileLocator = new FileLocator(resolveWorkDir(this.config));
    }
    return this._fileLocator;
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
   * workspace stores call this on create/delete/append (via `onMutate`), and a
   * workspace archive-delete calls it (via the membership-change hook), so the
   * locator and the conversations-tool index never serve a frozen summary or a
   * ghost of a deleted workspace.
   *
   * Scaling note: invalidation is tenant-wide and per-append, so under
   * concurrent chat the *list* index (summaries) rarely stays warm — the next
   * `listConversations` rebuilds by re-reading headers across workspaces. The hot
   * per-message resume path does NOT pay this (locate is a readdir-only walk,
   * see `ConversationLocator.locate`); only list views do. The recursive workspace
   * layout rules out the old `fs.watch` debounce-coalescing, so before a
   * high-conversation tenant feels it, the move is a per-workspace / incremental
   * index (update one entry on the changed conv's workspace) rather than a full
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
   * Conversation store for a user's private chats in ONE workspace
   * (`workspaces/<wsId>/conversations/<ownerId>/`). The workspace owns the
   * directory — the path is the boundary. Per-call instances are intentional
   * (the store is stateless w.r.t. its dir); the `onMutate` hook keeps the
   * conversation caches fresh on every write.
   */
  workspaceConversationStore(wsId: string, ownerId: string): EventSourcedConversationStore {
    return new EventSourcedConversationStore({
      dir: workspaceConversationsDir(resolveWorkDir(this.config), wsId, ownerId),
      logLevel: this.config.logging?.level ?? "normal",
      onMutate: () => this.notifyConversationsChanged(),
    });
  }

  /**
   * Resolve a conversation id to the workspace store that holds it, or `null` if no
   * workspace contains it. The single bridge from a bare `convId` (deep link,
   * history fetch, event append) to its workspace-owned store.
   */
  async resolveConversationStore(convId: string): Promise<EventSourcedConversationStore | null> {
    const loc = await this.getConversationLocator().locate(convId);
    if (!loc) return null;
    return this.workspaceConversationStore(loc.wsId, loc.ownerId ?? "");
  }

  /**
   * Resolve the workspace store for a chat turn. On resume the conversation's workspace
   * is authoritative (read from the locator); for a new conversation it's the
   * workspace the chat is born in (`createConvWsId` = the focused workspace, or the
   * caller's personal workspace when unfocused). Returns the store plus the resolved
   * workspace id so the create path can stamp the binding.
   */
  private async resolveChatStore(
    conversationId: string | undefined,
    createConvWsId: string,
    ownerId: string,
  ): Promise<{ store: EventSourcedConversationStore; convWsId: string }> {
    const { wsId, loc } = await this.resolveConversationLocation(
      conversationId,
      createConvWsId,
      ownerId,
    );
    const store = this.workspaceConversationStore(wsId, loc?.ownerId ?? ownerId);
    return { store, convWsId: wsId };
  }

  /**
   * True if `ownerId` may currently act in `wsId`. Personal workspaces are
   * sole-member by construction (always true); shared workspaces require current
   * membership. The shared "is this owner still allowed in this workspace" check
   * behind both the conversation-resume gate and the automation-run gate.
   */
  private async isOwnerWorkspaceMember(wsId: string, ownerId: string): Promise<boolean> {
    if (wsId === personalWorkspaceIdFor(ownerId)) return true;
    const ws = await this._workspaceStore.get(wsId);
    return ws?.members.some((m) => m.userId === ownerId) ?? false;
  }

  /**
   * Resume authorization — the second gate, after ownership. A conversation is
   * sealed to its workspace (`convWsId`): on resume the session's tools, skills,
   * apps, and context all resolve there. So resuming as a non-member would hand
   * someone offboarded from that workspace its tools — ambient authority into a
   * workspace they were removed from. Require CURRENT membership of the
   * conversation's workspace to RESUME (reads stay owner-gated — a removed member
   * can still read their own authored conversation).
   *
   * This is a per-RESUME check (once per conversation load), not the per-call
   * membership scan the wall forbids — it lands at session establishment, exactly
   * where the wall says the workspace must be membership-validated. Personal
   * workspaces are sole-member by construction, so they never gate.
   */
  private async assertOwnerIsWorkspaceMember(
    conversationId: string,
    convWsId: string,
    ownerId: string,
  ): Promise<void> {
    if (!(await this.isOwnerWorkspaceMember(convWsId, ownerId))) {
      throw new ConversationWorkspaceAccessDeniedError(conversationId, ownerId, convWsId);
    }
  }

  /**
   * The workspace a conversation lives in — for code outside the chat path (the
   * upload handlers, the file-serve route, and the per-turn `fileWorkspaceId`
   * that scopes the agent's `files__*` tools) that must resolve the SAME
   * partition `chat()` reads from when it rehydrates. A conversation not yet on
   * disk (a new chat) is born in `fallbackWsId`.
   */
  async resolveConversationWorkspaceId(
    conversationId: string | undefined,
    fallbackWsId: string,
    ownerId: string,
  ): Promise<string> {
    return (await this.resolveConversationLocation(conversationId, fallbackWsId, ownerId)).wsId;
  }

  /**
   * The single probe-then-locate for "which workspace does this conversation live
   * in" — the one place the partition rule lives, so the read (`resolveChatStore`),
   * the write (`resolveConversationWorkspaceId` → upload handlers / file serve), and
   * the file-tool scope (`RequestContext.fileWorkspaceId`) cannot drift apart.
   * Hot path: probe the focused/personal workspace directly (O(1) `existsSync`, no
   * tenant scan) — only a cross-workspace deep-link falls back to the locator walk.
   */
  private async resolveConversationLocation(
    conversationId: string | undefined,
    fallbackWsId: string,
    ownerId: string,
  ): Promise<{ wsId: string; loc: ConversationLocation | undefined }> {
    if (conversationId) {
      const directDir = workspaceConversationsDir(
        resolveWorkDir(this.config),
        fallbackWsId,
        ownerId,
      );
      if (existsSync(join(directDir, `${conversationId}.jsonl`))) {
        return { wsId: fallbackWsId, loc: undefined };
      }
      const loc = await this.getConversationLocator().locate(conversationId);
      if (loc) return { wsId: loc.wsId, loc };
    }
    return { wsId: fallbackWsId, loc: undefined };
  }

  /**
   * Locate a conversation by id across workspaces. Returns the `Conversation`
   * metadata, or `null` if no workspace holds it / the caller isn't the owner.
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
      this.config.models ??= this.getModelSlots(); // init from current
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
    // For `thinking` / `thinkingBudgetTokens`, `null` is the explicit
    // "clear my override" sentinel — distinct from `undefined` (leave alone).
    if (patch.thinking !== undefined) {
      this.config.thinking = patch.thinking === null ? undefined : patch.thinking;
    }
    if (patch.thinkingBudgetTokens !== undefined) {
      this.config.thinkingBudgetTokens =
        patch.thinkingBudgetTokens === null ? undefined : patch.thinkingBudgetTokens;
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

  /** SEP-2640 bundle skills as surface-once connector-skill candidates, so a server's
   *  skill can be delivered mid-turn when its tools are progressively disclosed (not only
   *  at turn-start via <layer3-skill>). Mirrors selectRequestLayer3's loadBundleSkills
   *  exclusion (the entered app's skill rides <app-guide>, not this channel).
   *
   *  Only `dynamic` (tool-affined) skills ride this channel: an `always` bundle
   *  skill is already composed into the context channel every turn, so surfacing
   *  it again on tool promotion would double-inject the same guidance. */
  private async loadBundleSkillCandidates(
    wsId: string,
    appContextServerName?: string,
  ): Promise<ConnectorSkillCandidate[]> {
    const skills = await this.loadBundleSkills(
      wsId,
      appContextServerName ? { appContextServerName } : {},
    );
    const { capability } = partitionSkillsByRole(skills);
    return capability.map((s) => ({
      name: s.manifest.name,
      body: s.body,
      scope: s.manifest.scope ?? BUNDLE_SKILL_SCOPE,
      toolAffinity: s.manifest.toolAffinity ?? [],
    }));
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
   * {@link loadConversationSkills}) with server-exposed `skill://<name>/SKILL.md`
   * skills from the focused workspace only — a bundle installed there whose
   * tools land in the workspace's tool list must also surface its workflow
   * guidance, else the model gets the namespaced tool name with no
   * instructions. A bundle in another workspace never contributes here.
   *
   * Discovered bundle skills are routed by the strategy they DECLARE, exactly
   * like filesystem skills: `partitionSkillsByRole` splits them so a `dynamic`
   * bundle skill feeds `selectLayer3Skills` (tool-affinity, `layer3`) while an
   * `always` bundle skill is returned in `context` for the caller to compose
   * into the always-on channel every turn. Conversation-tier context skills are
   * NOT returned here — the caller already partitioned those; `context` carries
   * only the always-on *bundle* skills the caller couldn't see.
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
  }): Promise<{ context: Skill[]; layer3: SelectedSkill[] }> {
    const capabilityPool =
      params.capabilityPool ??
      partitionSkillsByRole(this.loadConversationSkills(params.wsId, params.userId)).capability;
    // Bundle skills come from the FOCUSED workspace only — a connector installed
    // in another workspace must not inject its usage skill here (the wall).
    const bundleSkills = await this.loadBundleSkills(params.wsId, {
      ...(params.appContextServerName ? { appContextServerName: params.appContextServerName } : {}),
    });
    // Route the discovered bundle skills by their DECLARED strategy: `always`
    // skills go to the context channel (composed every turn), `dynamic` skills
    // join the tool-affinity capability pool that `selectLayer3Skills` filters.
    const { context: bundleContext, capability: bundleCapability } =
      partitionSkillsByRole(bundleSkills);
    const layer3 = selectLayer3Skills({
      skills: [...capabilityPool, ...bundleCapability],
      activeTools: params.activeToolNames,
    });
    return { context: bundleContext, layer3 };
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
    const { context: bundleContext, layer3 } = await this.selectRequestLayer3({
      wsId,
      userId,
      activeToolNames,
      capabilityPool: capability,
    });
    // Include always-on bundle skills in the reported context so the status
    // surface matches what the prompt actually composes.
    return { context: [...context, ...bundleContext], layer3 };
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
   * List conversations across workspaces via the locator. Pass `access` to filter
   * by ownership; without it the caller asserts trusted enumeration scope
   * (CLI, admin tools). Pass `options.workspaceId` for the workspace-scoped view (a
   * single workspace's chats); omit it for the owner's "All workspaces" view. The workspace
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

/**
 * Register placements declared by platform sources. The helper isolates the
 * duck-type — `getPlacements()` is on `McpSource` (carrying the declarations
 * from `defineInProcessApp`) but isn't on the `ToolSource` interface itself.
 */
function registerPlatformPlacements(
  placementRegistry: PlacementRegistry,
  platformSources: ToolSource[],
): void {
  for (const src of platformSources) {
    const placements = readSourcePlacements(src);
    if (placements.length > 0) {
      placementRegistry.register(src.name, placements);
    }
  }
}

/**
 * Seed lifecycle instances for boot-started workspace bundles, then re-register
 * any placements they carry.
 *
 * Operators are expected to have run `bun run migrate:user-creds` before
 * deploying Stage 2 (see the Stage 2 deploy runbook). The runtime no longer
 * migrates or normalizes legacy `oauthScope: "user"` records at boot; a legacy
 * ref reaches `seedInstance` only via `buildProcessInventory` and throws
 * `LegacyOAuthScopeError` there.
 */
function seedWorkspaceBundleInstances(
  lifecycle: BundleLifecycleManager,
  workspaceRegistries: Map<string, ToolRegistry>,
  placementRegistry: PlacementRegistry,
  entries: ProcessInventoryEntry[],
): void {
  for (const entry of entries) {
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

// Build the boot-time event sink: operator-supplied sinks plus the daily
// workspace log. Conversation event persistence is NOT wired here — conversations
// are workspace-owned, so each chat/task turn routes its engine events through its
// own per-call workspace store (see `_chatInner`). There is no flat top-level
// conversation store.
function buildEventSink(config: RuntimeConfig): EventSink {
  const sinks: EventSink[] = config.events ? [...config.events] : [];
  if (!config.logging?.disabled) {
    const workDir = resolveWorkDir(config);
    const logDir = config.logging?.dir ?? join(workDir, "logs");
    const retentionDays = config.logging?.retentionDays;
    // Workspace events (bundle lifecycle, bridge calls, audit) go to daily workspace log
    sinks.push(new WorkspaceLogSink({ dir: logDir, retentionDays }));
  }
  return sinks.length > 0 ? new MultiEventSink(sinks) : new NoopEventSink();
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

/** A user-message text content block. */
type UserTextPart = { type: "text"; text: string };
/** A user-message MCP `resource_link` attachment block. */
type UserResourceLinkPart = {
  type: "resource_link";
  uri: string;
  mimeType: string;
  name: string;
};

/**
 * Build a user message's content blocks: the text message plus any
 * `resource_link` attachment parts. Falls back to a synthetic `[Uploaded: …]`
 * text part when there's no text and no text content parts (a file-only upload)
 * so the content is never empty.
 */
function buildUserMessageContent(request: ChatRequest): Array<UserTextPart | UserResourceLinkPart> {
  // Bytes for binary attachments live in the workspace FileStore (already
  // persisted by `ingestFiles`); the conversation log carries only the URI.
  // The runtime rehydrates image links to AI SDK `file` parts at the
  // `model.doStream` boundary — see `rehydrateUserResources`.
  const userContent: Array<UserTextPart | UserResourceLinkPart> = [];
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
  // Ensure content is never empty — file-only uploads may have no text message.
  if (userContent.length === 0) {
    const filenames = request.fileRefs?.map((f) => f.filename).join(", ") || "files";
    userContent.push({ type: "text", text: `[Uploaded: ${filenames}]` });
  }
  return userContent;
}

/** Per-user prompt preferences resolved from the authenticated identity. */
function buildPromptPrefs(identity: UserIdentity): {
  displayName: string;
  timezone: string;
  locale: string;
} {
  return {
    displayName: identity.displayName ?? "",
    timezone: identity.preferences?.timezone ?? "",
    locale: identity.preferences?.locale ?? "en-US",
  };
}

/**
 * The "## Workspace" prompt block descriptor for a turn: `{ id, name }` when the
 * workspace record loaded, `{ id }` when only the id is known, or `undefined`
 * for the personal/session workspace (compose omits the block).
 */
function buildWorkspaceContext(
  wsId: string | undefined,
  workspace: Workspace | null | undefined,
): { id: string; name: string } | { id: string } | undefined {
  if (!wsId) return undefined;
  return workspace ? { id: workspace.id, name: workspace.name } : { id: wsId };
}

/**
 * The workspace-scoped RequestContext scope, carrying the session workspace's
 * agent profiles + model overrides (`null` when the record didn't load).
 */
function buildWorkspaceScope(
  workspaceId: string,
  workspace: Workspace | null | undefined,
): RequestScope {
  return {
    kind: "workspace",
    workspaceId,
    workspaceAgents: workspace?.agents ?? null,
    workspaceModelOverride: workspace?.models ?? null,
  };
}

/** Compose the present-only `surfaceTools` options (focused server + request-allowed tools). */
function buildSurfaceOptions(
  focusedServerName: string | undefined,
  requestAllowedTools: string[] | undefined,
): { focusedServerName?: string; requestAllowedTools?: string[] } {
  return {
    ...(focusedServerName ? { focusedServerName } : {}),
    ...(requestAllowedTools ? { requestAllowedTools } : {}),
  };
}

/** Append the workspace identity/persona override skill to the context channel when the workspace sets one. */
function withIdentityOverride(
  contextBase: Skill[],
  workspaceIdentity: string | undefined,
): Skill[] {
  if (!workspaceIdentity) return contextBase;
  return [...contextBase, makeIdentitySkill(workspaceIdentity)];
}

/**
 * Build the per-request `transformContext` hook: slice history → apply the
 * provider reasoning-replay policy → window by token budget. `overflowAttempt`
 * halves the budget per retry after a provider context-window rejection.
 */
export function buildTransformContext(
  budgetBase: number,
  replayProvider: ReturnType<typeof getProviderFromModel>,
): NonNullable<EngineHooks["transformContext"]> {
  return (historyMessages, opts) => {
    // `overflowAttempt > 0` means the provider rejected the prior call for
    // exceeding the model's context window; halve the composed budget per
    // attempt and re-window (the engine caps recovery at one attempt today).
    const attempt = opts?.overflowAttempt ?? 0;
    const budget = attempt > 0 ? Math.floor(budgetBase / (1 << attempt)) : budgetBase;
    // History is append-only within a turn — windowMessages (the token budget)
    // is the sole bound. A per-call group-count slice is deliberately NOT
    // applied here: it would drop the oldest group each iteration, shifting the
    // cached prefix and busting the prompt cache mid-turn. Keeping the prefix
    // stable lets the growing history read back from cache instead of re-writing.
    const replayReady = applyReasoningReplayPolicy(historyMessages, replayProvider);
    return windowMessages(replayReady, budget);
  };
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
