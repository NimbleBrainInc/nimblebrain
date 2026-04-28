import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { NoopEventSink } from "../adapters/noop-events.ts";
import { WorkspaceLogSink } from "../adapters/workspace-log-sink.ts";
import { BundleLifecycleManager } from "../bundles/lifecycle.ts";
import { deriveServerName } from "../bundles/paths.ts";
import type { AppInfo, BundleInstance } from "../bundles/types.ts";
import { log } from "../cli/log.ts";
import { isToolVisibleToRole, type ResolvedFeatures, resolveFeatures } from "../config/features.ts";
import { createPrivilegeHook, NoopConfirmationGate } from "../config/privilege.ts";
import { generateTitle } from "../conversation/auto-title.ts";
import { EventSourcedConversationStore } from "../conversation/event-sourced-store.ts";
import { JsonlConversationStore } from "../conversation/jsonl-store.ts";
import { InMemoryConversationStore } from "../conversation/memory-store.ts";
import type {
  ConversationListResult,
  ConversationStore,
  ParticipantInfo,
} from "../conversation/types.ts";
import { sliceHistory, windowMessages } from "../conversation/window.ts";
import { estimateCost } from "../engine/cost.ts";
import { AgentEngine } from "../engine/engine.ts";
import { RunMetricsCollector } from "../engine/run-metrics.ts";
import type {
  EngineConfig,
  EngineEvent,
  EngineHooks,
  EventSink,
  ToolSchema,
} from "../engine/types.ts";
import { DEFAULT_FILE_CONFIG, type FileConfig } from "../files/types.ts";
import type { InstanceConfig } from "../identity/instance.ts";
import { loadInstanceConfig } from "../identity/instance.ts";
import type { IdentityProvider, UserIdentity } from "../identity/provider.ts";
import { createIdentityProvider } from "../identity/provider.ts";
import { DEV_IDENTITY } from "../identity/providers/dev.ts";
import { UserStore } from "../identity/user.ts";
import { InstructionsStore } from "../instructions/index.ts";
import { buildModelResolver } from "../model/registry.ts";
import type { PromptAppInfo } from "../prompt/compose.ts";
import { composeSystemPrompt } from "../prompt/compose.ts";
import {
  loadBuiltinSkills,
  loadCoreSkills,
  loadSkillDir,
  partitionSkills,
} from "../skills/loader.ts";
import { SkillMatcher } from "../skills/matcher.ts";
import type { Skill } from "../skills/types.ts";
import { TelemetryManager } from "../telemetry/manager.ts";
import { PostHogEventSink } from "../telemetry/posthog-sink.ts";
import type { DelegateContext } from "../tools/delegate.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { createSystemTools } from "../tools/system-tools.ts";
import type { ResourceData } from "../tools/types.ts";
import { WorkspaceStore } from "../workspace/workspace-store.ts";
import { RunInProgressError } from "./errors.ts";
import { PlacementRegistry } from "./placement-registry.ts";
import {
  getRequestContext,
  type RequestContext,
  runWithRequestContext,
} from "./request-context.ts";
import { surfaceTools } from "./tools.ts";
import type { ChatRequest, ChatResult, ModelSlots, RuntimeConfig, TurnUsage } from "./types.ts";
import { createWorkspaceRegistry, startWorkspaceBundles } from "./workspace-runtime.ts";

const DEFAULT_WORK_DIR = join(homedir(), ".nimblebrain");
const DEFAULT_MODEL = "claude-sonnet-4-6";

import { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_ITERATIONS } from "../limits.ts";
import { resolveMaxOutputTokens } from "./resolve-max-output-tokens.ts";

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
  return config.workDir ?? DEFAULT_WORK_DIR;
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
  private _identityProvider: IdentityProvider | null;
  /** Getter for the current request identity — reads from AsyncLocalStorage. */
  _getIdentity: () => UserIdentity | null = () => null;
  /** Getter for the current request workspace ID — reads from AsyncLocalStorage. */
  _getWorkspaceId: () => string | null = () => null;
  /** Per-workspace ToolRegistry instances — each workspace gets its own scoped registry. */
  private _workspaceRegistries: Map<string, ToolRegistry>;
  // Protected sources are captured in start() and passed to startWorkspaceBundles directly.
  /** The system source ("nb") — shared across workspace registries. */
  _systemSource: import("../tools/types.ts").ToolSource | null;
  /** Platform sources (home, conversations, files, etc.) — retained for JIT workspace registration. */
  private _platformSources: import("../tools/types.ts").ToolSource[] = [];
  /** Getter for current workspace ID (set per-request). */
  private _currentWorkspaceId: (() => string | null) | null = null;
  private _manageConversationCtx:
    | import("../tools/conversation-tools.ts").ManageConversationContext
    | null = null;
  private skillResourceCache = new Map<string, { content: string; fetchedAt: number }>();
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

  private constructor(
    _engine: AgentEngine,
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
    systemSource: import("../tools/types.ts").ToolSource | null,
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
    this._identityProvider = identityProvider;
    this._workspaceRegistries = workspaceRegistries;
    this._systemSource = systemSource;
    this._currentWorkspaceId = currentWorkspaceId;
  }

  /** Create and start a runtime from config. */
  static async start(config: RuntimeConfig): Promise<Runtime> {
    const resolveModelFn = resolveModel(config);

    const telemetryManager = TelemetryManager.create({
      workDir: resolveWorkDir(config),
      enabled: config.telemetry?.enabled,
      mode: "serve",
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
    const sinkList: EventSink[] = [baseEvents, delegateTracker];
    if (eventStore) {
      sinkList.push(eventStore);
    }
    if (telemetryManager.isEnabled()) {
      sinkList.push(new PostHogEventSink(telemetryManager));
    }
    const events: EventSink = new MultiEventSink(sinkList);

    // Mint a scoped internal token for protected default bundles.
    // Rotated on every runtime restart — never persisted.
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

    const gate = config.confirmationGate ?? new NoopConfirmationGate();

    const maxInputTokens = config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    const maxHistoryMessages = config.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;

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
      get tools() {
        if (!rtHolder.rt) throw new Error("Runtime not initialized");
        return rtHolder.rt.getRegistryForCurrentWorkspace();
      },
      events,
      // Use getter so workspace agents override instance agents per-request.
      // Workspace agents merge over (not replace) instance agents.
      // Prefers AsyncLocalStorage context for concurrency safety.
      get agents() {
        const wsAgents = getRequestContext()?.workspaceAgents ?? null;
        if (wsAgents) {
          return { ...(config.agents ?? {}), ...wsAgents };
        }
        return config.agents;
      },
      getRemainingIterations: () => delegateTracker.getRemainingIterations(),
      getParentRunId: () => delegateTracker.getParentRunId(),
      defaultModel: getDefaultModel(),
      defaultMaxInputTokens: maxInputTokens,
      // Raw operator config (may be undefined). Delegate resolves against
      // the child's model via resolveMaxOutputTokens at execution time.
      configMaxOutputTokens: config.maxOutputTokens,
    };

    // System tools (search, manage_app, bundle_status, manage_skill, delegate)
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
      transformContext: (messages) => {
        const sliced = sliceHistory(messages, maxHistoryMessages);
        return windowMessages(sliced, maxInputTokens);
      },
    };

    const store = buildStore(config);
    const { contextSkills, skillMatcher } = buildSkills(config);
    const defaultModelId = getDefaultModel();
    // Workspace-aware ToolRouter proxy: the engine calls availableTools()/execute()
    // within runWithRequestContext(), so the proxy reads the current workspace's registry.
    const workspaceToolRouter: import("../engine/types.ts").ToolRouter = {
      availableTools: () => {
        if (!rtHolder.rt) throw new Error("Runtime not initialized");
        return rtHolder.rt.getRegistryForCurrentWorkspace().availableTools();
      },
      execute: (call) => {
        if (!rtHolder.rt) throw new Error("Runtime not initialized");
        return rtHolder.rt.getRegistryForCurrentWorkspace().execute(call);
      },
    };
    const engine = new AgentEngine(resolveModelFn(defaultModelId), workspaceToolRouter, events);

    // Request-scoped context — all identity/workspace reads go through AsyncLocalStorage.
    // Set via runWithRequestContext() in chat(), handleToolCall(), and MCP handler.
    const getIdentity = (): UserIdentity | null => getRequestContext()?.identity ?? null;
    const getWorkspaceId = (): string | null => getRequestContext()?.workspaceId ?? null;

    // Build management tool contexts using the identity holder + stores from task 001
    // ManageUsersContext is always created. In dev mode (no identity provider),
    // the tool can still list/update/delete users — it just can't create
    // users with API keys (that requires a provider with credential login).
    const manageUsersCtx = { getIdentity, userStore, provider: identityProvider };
    const manageWorkspacesCtx = { getIdentity, workspaceStore };
    const manageMembersCtx = { getIdentity, workspaceStore, userStore };
    const manageConversationCtx: import("../tools/conversation-tools.ts").ManageConversationContext =
      {
        getIdentity,
        conversationStore: store,
        workspaceStore,
      };
    const manageBundleCtx = {
      getWorkspaceId,
      workspaceStore,
      workDir: resolveWorkDir(config),
      configDir: config.configPath ? dirname(config.configPath) : undefined,
      allowInsecureRemotes: config.allowInsecureRemotes,
      // The runtime sink flows into every McpSource spawned by manage_app
      // install/configure. Keeps chat-initiated bundle installs on the same
      // live-update pipeline as boot-time bundle startup.
      eventSink: events,
    };

    // Create Runtime with empty workspace registries first — needed by system tools
    const rt = new Runtime(
      engine,
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
    rt._manageConversationCtx = manageConversationCtx;

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
      mpakHome,
      manageUsersCtx,
      manageWorkspacesCtx,
      manageMembersCtx,
      manageConversationCtx,
      manageBundleCtx,
    );
    rt._systemSource = systemTools;

    // Phase 2: Create platform capability sources. Each is an in-process
    // MCP server reachable through `InMemoryTransport` — no subprocess.
    // `createPlatformSources` returns sources already started.
    const { createPlatformSources } = await import("../tools/platform/index.ts");
    const platformSources = await createPlatformSources(rt, events);

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

    // Phase 3: Start workspace bundles with per-workspace registries
    const configDir = config.configPath ? dirname(config.configPath) : undefined;
    const { registries: workspaceRegistries, entries: workspaceBundleEntries } =
      await startWorkspaceBundles(workspaceStore, platformSources, systemTools, events, configDir, {
        workDir: resolveWorkDir(config),
        allowInsecureRemotes: config.allowInsecureRemotes,
      });
    rt._workspaceRegistries = workspaceRegistries;
    rt._platformSources = platformSources;

    // Seed lifecycle instances for workspace bundles (user-installed only)
    for (const entry of workspaceBundleEntries) {
      const { serverName: sn, bundle: ref, meta, wsId, dataDir } = entry;
      const label = "name" in ref ? ref.name : "url" in ref ? ref.url : ref.path;
      lifecycle.seedInstance(sn, label, ref, meta ?? undefined, wsId, dataDir);

      const instance = lifecycle.getInstance(sn, wsId);
      if (instance?.ui?.placements && instance.ui.placements.length > 0) {
        placementRegistry.register(sn, instance.ui.placements, wsId);
      }
    }

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

  private async _chatInner(request: ChatRequest, requestSink?: EventSink): Promise<ChatResult> {
    if (!request.workspaceId) {
      throw new Error("workspaceId is required. Every chat request must be workspace-scoped.");
    }
    const wsId = request.workspaceId;

    // Resolve conversation store: always workspace-scoped.
    // JsonlConversationStore is stateless (each operation reads from disk),
    // so per-request instances are safe.
    const workDir = resolveWorkDir(this.config);
    const wsConvDir = join(workDir, "workspaces", wsId, "conversations");
    const store: ConversationStore = new EventSourcedConversationStore({
      dir: wsConvDir,
      logLevel: this.config.logging?.level ?? "normal",
    });

    // Load workspace config once per request for agents/models overrides.
    const workspace = await this._workspaceStore.get(wsId);

    const createOpts = {
      ownerId: request.identity?.id,
      workspaceId: wsId,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    const conversation = request.conversationId
      ? ((await store.load(request.conversationId)) ?? (await store.create(createOpts)))
      : await store.create(createOpts);

    // Preserve metadata on resumed conversations (don't overwrite)
    if (request.metadata && !conversation.metadata) {
      conversation.metadata = request.metadata;
    }

    // Build user message content: text + optional file content parts
    type TextPart = { type: "text"; text: string };
    type FilePart = { type: "file"; data: Uint8Array; mediaType: string; filename?: string };
    const userContent: Array<TextPart | FilePart> = [];
    if (request.message) {
      userContent.push({ type: "text", text: request.message });
    }
    if (request.contentParts?.length) {
      for (const part of request.contentParts) {
        if (part.type === "text") {
          userContent.push({ type: "text", text: part.text });
        } else if (part.type === "image") {
          userContent.push({ type: "file", data: part.image, mediaType: part.mimeType });
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

    let skill = this.skillMatcher.match(request.message);

    // Dependency checking: warn if a matched skill requires bundles that aren't installed
    if (skill?.manifest.requiresBundles?.length) {
      const missing: string[] = [];
      for (const bundleName of skill.manifest.requiresBundles) {
        const serverName = deriveServerName(bundleName);
        if (!this.lifecycle?.getInstance(serverName, wsId)) {
          missing.push(bundleName);
        }
      }
      if (missing.length > 0) {
        skill = {
          ...skill,
          body:
            skill.body +
            `\n\n⚠️ Missing dependencies: ${missing.join(", ")}. Some capabilities may be unavailable. Install with nb__manage_app.`,
        };
      }
    }

    // `buildAppsList` populates each app's `customInstructions` from the
    // bundle's `app://instructions` resource (when published);
    // org and workspace overlays come from platform-owned storage.
    const apps = await this.buildAppsList(wsId);
    const liveOverlays = await this.readPromptOverlays(wsId);

    // Workspace-scoped registry for this request
    const activeRegistry = this.getRegistryForWorkspace(wsId);

    // Build focusedApp when the request is scoped to a specific app (§7 app-aware chat)
    let focusedApp: import("../prompt/compose.ts").FocusedAppInfo | undefined;
    if (request.appContext) {
      const source = activeRegistry
        .getSources()
        .find((s) => s.name === request.appContext?.serverName);
      if (source) {
        try {
          const sourceTools = await source.tools();
          const skillResource = await this.getAppSkillResource(request.appContext.serverName);
          const referenceUri = `skill://${request.appContext.serverName}/reference`;
          const hasReference = skillResource
            ? source instanceof McpSource && (await this.hasResource(source, referenceUri))
            : false;
          const bundleInstance = this.lifecycle?.getInstance(request.appContext.serverName, wsId);
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
        } catch {
          // Source may be stopped or crashed — skip silently
        }
      }
    }

    // Build appState for prompt injection (Synapse Feature 2 — LLM-aware UI state)
    let appState: import("../prompt/compose.ts").AppStateInfo | undefined;
    if (request.appContext?.appState && focusedApp) {
      const bundleRef = this.lifecycle?.getInstance(request.appContext.serverName, wsId);
      appState = {
        state: request.appContext.appState.state,
        summary: request.appContext.appState.summary,
        updatedAt: request.appContext.appState.updatedAt,
        trustScore: bundleRef?.trustScore ?? 100,
      };
    }

    const allTools = (await activeRegistry.availableTools()).filter((t) =>
      isToolVisibleToRole(t.name, request.identity?.orgRole),
    );
    const { direct: tools, proxied } = surfaceTools(allTools, skill, {
      focusedServerName: request.appContext?.serverName,
      requestAllowedTools: request.allowedTools,
    });

    // Per-user preferences from the authenticated identity
    const reqIdentity = request.identity ?? this.getCurrentIdentity();
    const prefs = {
      displayName: reqIdentity?.displayName ?? "",
      timezone: reqIdentity?.preferences?.timezone ?? "",
      locale: reqIdentity?.preferences?.locale ?? "en-US",
    };

    // Build participants for shared conversations
    let participants: ParticipantInfo[] | undefined;
    if (conversation.visibility === "shared" && conversation.participants?.length) {
      participants = [];
      for (const userId of conversation.participants) {
        const user = await this._userStore.get(userId);
        participants.push({
          userId,
          displayName: user?.displayName ?? userId,
        });
      }
    }

    const workspaceContext = workspace ? { id: workspace.id, name: workspace.name } : { id: wsId };

    // Build per-request context skills with workspace identity override
    const identityOverride = workspace?.identity ? makeIdentitySkill(workspace.identity) : null;
    const requestContextSkills = identityOverride
      ? [...this.contextSkills, identityOverride]
      : this.contextSkills;

    const systemPrompt = composeSystemPrompt(
      requestContextSkills,
      skill,
      apps,
      focusedApp,
      appState,
      prefs,
      proxied.length > 0,
      participants,
      workspaceContext,
      liveOverlays,
    );

    const messages = await store.history(conversation);

    // Workspace model overrides are in the RequestContext — read via getModelSlot()

    // Resolve model: support alias references (e.g., "alias:fast", "alias:reasoning")
    let resolvedModelString = request.model ?? this.getDefaultModel();
    const aliasSlot = parseAliasRef(resolvedModelString);
    if (aliasSlot) {
      resolvedModelString = this.getModelSlot(aliasSlot);
    }

    const engineConfig: EngineConfig = {
      model: resolvedModelString,
      maxIterations: request.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      maxInputTokens: this.config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: resolveMaxOutputTokens({
        configValue: this.config.maxOutputTokens,
        model: resolvedModelString,
      }),
      maxToolResultSize: this.config.maxToolResultSize,
      hooks: this.hooks,
    };

    // Determine which event store handles conversation events for this request.
    // For workspace-scoped requests, use the workspace store instead of the global one.
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

    // Create a per-turn metrics collector to capture cache tokens and LLM latency
    const metricsCollector = new RunMetricsCollector();

    // Build per-request sink chain
    const sinks: EventSink[] = requestSink
      ? [requestSink, this.defaultEvents, metricsCollector]
      : [this.defaultEvents, metricsCollector];
    if (isWorkspaceRequest) {
      sinks.push(store as EventSourcedConversationStore);
    }

    const model = engineConfig.model;
    const resolvedModel = this.resolveModelFn(model);
    const engine = new AgentEngine(resolvedModel, activeRegistry, new MultiEventSink(sinks));

    // When auth is configured, identity and workspace are mandatory.
    // Reject early rather than running in a degraded state with null identity.
    if (this._identityProvider) {
      if (!request.identity) {
        throw new Error(
          "Identity required: auth provider is configured but no identity was provided to runtime.chat()",
        );
      }
    }

    // In dev mode (no auth provider), fall back to the dev identity.
    const requestIdentity = request.identity ?? DEV_IDENTITY;

    // Build the request context for AsyncLocalStorage.
    // This makes identity/workspace available to all async operations within
    // engine.run() (including parallel tool calls) without mutable singletons.
    const reqCtx: RequestContext = {
      identity: requestIdentity,
      workspaceId: wsId,
      workspaceAgents: workspace?.agents ?? null,
      workspaceModelOverride: workspace?.models ?? null,
    };

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

    const result = await runWithRequestContext(reqCtx, () =>
      engine.run(engineConfig, systemPrompt, messages, tools),
    );

    const usage: TurnUsage = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: metricsCollector.cacheReadTokens,
      costUsd: estimateCost(model, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: metricsCollector.cacheReadTokens,
      }),
      model,
      llmMs: metricsCollector.totalLlmMs,
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
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: metricsCollector.cacheReadTokens,
          costUsd: usage.costUsd,
          model,
          llmMs: metricsCollector.totalLlmMs,
          iterations: result.iterations,
        },
      });
    }

    // Fire-and-forget title generation on first turn (use "fast" slot for cost savings)
    if (conversation.title === null) {
      const titleModel = this.resolveModelFn(this.getModelSlot("fast"));
      const titleInput =
        request.message ||
        `[Uploaded: ${request.fileRefs?.map((f) => f.filename).join(", ") || "files"}]`;
      void generateTitle(titleModel, titleInput, result.output).then(
        (title) => {
          void store.update(conversation.id, { title });
        },
        (err) => console.error("[runtime] title generation failed:", err),
      );
    }

    return {
      response: result.output,
      conversationId: conversation.id,
      workspaceId: wsId,
      skillName: skill?.manifest.name ?? null,
      toolCalls: result.toolCalls,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      stopReason: result.stopReason,
      usage,
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

  /** Scoped internal token for protected default bundles. Rotated on every restart. */
  getInternalToken(): string {
    return this._internalToken;
  }

  /** Fetch the skill:// usage resource for an app's MCP server, with caching. */
  private async getAppSkillResource(serverName: string): Promise<string | null> {
    const cached = this.skillResourceCache.get(serverName);
    if (cached && Date.now() - cached.fetchedAt < Runtime.SKILL_CACHE_TTL) {
      return cached.content;
    }

    // Search across all workspace registries for the source
    let source: import("../tools/types.ts").ToolSource | undefined;
    for (const reg of this._workspaceRegistries.values()) {
      source = reg.getSources().find((s) => s.name === serverName);
      if (source) break;
    }
    if (!(source instanceof McpSource)) return null;

    try {
      const resource = await source.readResource(`skill://${serverName}/usage`);
      const content = resource?.text ?? null;
      if (content) {
        // Token budget: cap at ~3000 tokens (~12000 chars)
        const truncated =
          content.length > 12000 ? `${content.slice(0, 12000)}\n\n[truncated]` : content;
        this.skillResourceCache.set(serverName, {
          content: truncated,
          fetchedAt: Date.now(),
        });
        return truncated;
      }
    } catch {
      // Resource doesn't exist or read failed — skip silently
    }
    return null;
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
  private async buildAppsList(workspaceId: string): Promise<PromptAppInfo[]> {
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
  private async readPromptOverlays(wsId: string): Promise<{ org: string; workspace: string }> {
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

  /** Get the ToolRegistry for the current request's workspace (from AsyncLocalStorage context). */
  getRegistryForCurrentWorkspace(): ToolRegistry {
    const wsId = this._currentWorkspaceId?.();
    if (!wsId) {
      throw new Error("No workspace in request context. Every request must be workspace-scoped.");
    }
    return this.getRegistryForWorkspace(wsId);
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

    const wsRegistry = createWorkspaceRegistry(this._platformSources, this._systemSource);
    this._workspaceRegistries.set(wsId, wsRegistry);
    return wsRegistry;
  }

  /** Get a workspace-scoped ConversationStore. */
  getStore(wsId?: string): ConversationStore {
    const id = wsId ?? this.requireWorkspaceId();
    const workDir = resolveWorkDir(this.config);
    return new EventSourcedConversationStore({
      dir: join(workDir, "workspaces", id, "conversations"),
      logLevel: this.config.logging?.level ?? "normal",
    });
  }

  /** Alias for getStore() — clearer name for conversation-specific usage. */
  getConversationStore(wsId?: string): ConversationStore {
    return this.getStore(wsId);
  }

  /** Get the UserStore instance. */
  getUserStore(): UserStore {
    return this._userStore;
  }

  /** Get the WorkspaceStore instance. */
  getWorkspaceStore(): WorkspaceStore {
    return this._workspaceStore;
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
   * Resolve the workspace-scoped data directory for the current request.
   * Returns `{workDir}/workspaces/{wsId}` when a workspace is active.
   * Dev mode (no identity provider) falls back to global workDir.
   */
  getWorkspaceScopedDir(wsId?: string | null): string {
    const id = wsId ?? this.getCurrentWorkspaceId();
    const workDir = resolveWorkDir(this.config);
    if (id) return join(workDir, "workspaces", id);

    // Dev mode (no identity provider) — allow global fallback for local development
    if (!this._identityProvider) return workDir;

    throw new Error("No workspace context — cannot resolve scoped directory.");
  }

  /** Get the loaded InstanceConfig (null when no instance.json exists — dev mode). */
  getInstanceConfig(): InstanceConfig | null {
    return this._instanceConfig;
  }

  /** Get the resolved model slots (all three, with fallback logic).
   *  When a workspace model override is active (set per-request in chat()),
   *  workspace slots are merged over instance defaults. */
  getModelSlots(): ModelSlots {
    const models = this.config.models;
    const fallback = this.config.defaultModel ?? DEFAULT_MODEL;
    const base: ModelSlots = {
      default: models?.default ?? fallback,
      fast: models?.fast ?? fallback,
      reasoning: models?.reasoning ?? fallback,
    };
    // Merge workspace model overrides from request context (partial — only overrides specified slots)
    const wsModels = getRequestContext()?.workspaceModelOverride;
    if (wsModels) {
      return {
        default: wsModels.default ?? base.default,
        fast: wsModels.fast ?? base.fast,
        reasoning: wsModels.reasoning ?? base.reasoning,
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

  /** Update live runtime config (in-memory). Called by set_config tool after disk write. */
  updateConfig(patch: {
    defaultModel?: string;
    models?: Partial<ModelSlots>;
    maxIterations?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxToolResultSize?: number;
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
  }

  /** Get loaded context skills (for skill_status tool). */
  getContextSkills(): Skill[] {
    return this.contextSkills;
  }

  /** Get loaded matchable skills (for skill_status tool). */
  getMatchableSkills(): Skill[] {
    return this.skillMatcher.getSkills();
  }

  /** Get the path to the nimblebrain.json config file. */
  getConfigPath(): string | undefined {
    return this.config.configPath;
  }

  /** Get current runtime config values (safe subset — no secrets). */
  getRuntimeConfig(): {
    models: ModelSlots;
    defaultModel: string;
    maxIterations: number;
    maxInputTokens: number;
    maxOutputTokens: number;
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

  /** Inject the per-conversation event manager for participant eviction on removal/unshare. */
  setConversationEventManager(
    manager: import("../api/conversation-events.ts").ConversationEventManager,
  ): void {
    if (this._manageConversationCtx) {
      this._manageConversationCtx.conversationEventManager = manager;
    }
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

  /** List conversations (workspace-scoped). */
  async listConversations(
    options?: import("../conversation/types.ts").ListOptions,
    wsId?: string,
  ): Promise<ConversationListResult> {
    return this.getStore(wsId).list(options);
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
    if (!(source instanceof McpSource)) return null;

    if (resourcePath.includes("://")) {
      return source.readResource(resourcePath);
    }

    const exactUri = `ui://${resourcePath}`;
    const namespacedUri = `ui://${appName}/${resourcePath}`;

    const result = await source.readResource(exactUri);
    if (result !== null) return result;
    if (exactUri !== namespacedUri) return source.readResource(namespacedUri);
    return null;
  }

  async shutdown(): Promise<void> {
    await this.telemetryManager.shutdown();
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
function readSourcePlacements(
  src: import("../tools/types.ts").ToolSource,
): import("../bundles/types.ts").PlacementDeclaration[] {
  const fn = (src as { getPlacements?: () => unknown }).getPlacements;
  if (typeof fn !== "function") return [];
  const out = fn.call(src);
  return Array.isArray(out) ? (out as import("../bundles/types.ts").PlacementDeclaration[]) : [];
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
  let eventStore: EventSourcedConversationStore | null = null;
  const sinks: EventSink[] = config.events ? [...config.events] : [];
  if (!config.logging?.disabled) {
    const workDir = resolveWorkDir(config);
    const logDir = config.logging?.dir ?? join(workDir, "logs");
    const retentionDays = config.logging?.retentionDays;
    // Workspace events (bundle lifecycle, bridge calls, audit) go to daily workspace log
    sinks.push(new WorkspaceLogSink({ dir: logDir, retentionDays }));
    // Conversation events are handled by the EventSourcedConversationStore (added to sink chain in start())
    eventStore = new EventSourcedConversationStore({
      dir: join(workDir, "conversations"),
      logLevel: config.logging?.level ?? "normal",
    });
  }
  const events: EventSink = sinks.length > 0 ? new MultiEventSink(sinks) : new NoopEventSink();
  return { events, eventStore };
}

function buildStore(config: RuntimeConfig): ConversationStore {
  if (config.store?.type === "memory") return new InMemoryConversationStore();
  if (config.store?.type === "jsonl") return new JsonlConversationStore(config.store.dir);
  if (config.store?.type === "custom") return config.store.adapter;
  // Default: event-sourced JSONL persistence in workDir/conversations/
  const workDir = resolveWorkDir(config);
  return new EventSourcedConversationStore({
    dir: join(workDir, "conversations"),
    logLevel: config.logging?.level ?? "normal",
  });
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
 * Create a synthetic identity skill from a workspace's identity markdown.
 * Injected at priority 1 (core context layer) so it becomes the agent persona.
 */
function makeIdentitySkill(body: string): Skill {
  return {
    manifest: {
      name: "identity-override",
      description: "Workspace identity override",
      version: "1.0.0",
      type: "context",
      priority: 1,
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
