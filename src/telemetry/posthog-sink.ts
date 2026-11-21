import { dispatchEngineEvent, type EngineEventHandlers } from "../engine/event-dispatch.ts";
import type {
  ConnectionStateChangedPayload,
  ConnectorInstalledPayload,
  LlmDonePayload,
  RunDonePayload,
  RunErrorPayload,
  RunStartPayload,
  SkillCreatedPayload,
  SkillsLoadedPayload,
  ToolDonePayload,
} from "../engine/schemas/events.ts";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import {
  IDENTITY_SOURCES,
  isPersonalConnectorName,
  personalConnectorServerName,
} from "../tools/identity-sources.ts";
import { splitInnerToolName } from "../util/tool-name.ts";
import type { TelemetryManager } from "./manager.ts";

/** Whose connector records hold a connector: a workspace's, or one person's own plugins. */
export type ConnectorOwner = { workspaceId: string } | { userId: string };

/**
 * A connector's catalog id, or `undefined` when it is not from the catalog
 * (added by URL, under a name someone chose). The runtime supplies it; the
 * sink never reads connector records itself.
 */
export type ConnectorCatalogResolver = (
  owner: ConnectorOwner,
  serverName: string,
) => Promise<string | undefined>;

/**
 * The sign-in event a connection's state change means: entering `pending_auth`
 * starts one, leaving it for `running` completes it, leaving it any other way
 * fails it, and `running` falling to `reauth_required` loses it.
 */
function authEventFor(previous: string | undefined, state: string): string | undefined {
  if (state === "pending_auth")
    return previous === "pending_auth" ? undefined : "connector.auth_started";
  if (previous === "pending_auth")
    return state === "running" ? "connector.auth_completed" : "connector.auth_failed";
  if (previous === "running" && state === "reauth_required") return "connector.auth_lost";
  return undefined;
}

/** What an identified event names in place of a connector or skill not from the catalog. */
const CUSTOM = "custom";

/** Per-run metric accumulator. */
interface RunMetrics {
  startedAt: number;
  /** Identified only: the run's model, and what it used, as catalog names or `custom`. */
  model?: string;
  /** Identified only: what woke the run (`chat`, `schedule`, `manual`, `event`, `api`). */
  trigger?: string;
  connectors: Set<Promise<string>>;
  skills: Set<Promise<string>>;
  iterations: number;
  toolCalls: number;
  connectorToolCalls: number;
  /** The summed latency of the run's timed model calls. */
  llmMs: number;
  /**
   * Model calls recorded with no latency (`llmMs` 0): an external agent's, which
   * ACP reports no timing for. A run with any reports no `llm_latency_ms`.
   */
  untimedLlmCalls: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
}

function createRunMetrics(): RunMetrics {
  return {
    startedAt: Date.now(),
    connectors: new Set(),
    skills: new Set(),
    iterations: 0,
    toolCalls: 0,
    connectorToolCalls: 0,
    llmMs: 0,
    untimedLlmCalls: 0,
    toolMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
  };
}

/**
 * EventSink that forwards anonymized, aggregate telemetry to PostHog
 * via TelemetryManager. Accumulates per-run metrics keyed by runId,
 * supporting concurrent runs without cross-contamination.
 *
 * CRITICAL: Never captures connector names, paths, tool names, error messages,
 * or any string that could contain PII.
 */
export class PostHogEventSink implements EventSink {
  private telemetry: TelemetryManager;
  private runs: Map<string, RunMetrics> = new Map();

  /**
   * Dispatch table keyed by engine event type. Accumulation events fold into
   * per-run metrics; capture events emit to PostHog. Event types absent here
   * (deltas, tool.start/progress, config.changed, and anything unknown)
   * are intentionally ignored.
   */
  private readonly handlers: EngineEventHandlers = {
    "llm.done": (data) => this.accumulateLlm(data),
    "tool.done": (data) => this.accumulateTool(data),
    "run.start": (data) => this.captureRunStart(data),
    "run.done": (data) => this.captureRunDone(data),
    "run.error": (data) => this.captureRunError(data),
    "connector.installed": (data) => this.captureConnectorInstalled(data),
    "connector.uninstalled": () => this.captureConnectorUninstalled(),
    "skills.loaded": (data) => this.recordSkills(data),
    "skill.created": (data) => this.captureSkillCreated(data),
    "connection.state_changed": (data) => this.captureConnectionChange(data),
  };

  /**
   * Tool sources the kernel ships (`nb`, the identity sources, and the platform
   * apps the runtime adds at start). A call to any other source is a call to a
   * connector the person installed, the step that shows the install is in use.
   */
  private readonly builtinSources = new Set<string>(["nb", ...IDENTITY_SOURCES]);

  private resolveConnector: ConnectorCatalogResolver = async () => undefined;
  /** `<wsId>|<serverName>` → its catalog id or `custom`, resolved once. */
  private readonly connectorIds = new Map<string, Promise<string>>();
  /** Each connection's last state, `<owner>|<serverName>|<principal>`, to read a sign-in's outcome from its transition. */
  private readonly connectionStates = new Map<string, string>();

  constructor(telemetry: TelemetryManager) {
    this.telemetry = telemetry;
  }

  /** How a workspace connector maps to its catalog id. Set by the runtime. */
  setConnectorResolver(resolver: ConnectorCatalogResolver): void {
    this.resolveConnector = resolver;
    this.connectorIds.clear();
  }

  /** Whether events may name connectors, tools, skills and models (hosted, identified deployments only). */
  private named(): boolean {
    return this.telemetry.isIdentified();
  }

  /** A connector's catalog id, or `custom`. Never the name it was installed under, which someone may have chosen. */
  private connectorId(owner: ConnectorOwner | undefined, serverName: string): Promise<string> {
    if (!owner) return Promise.resolve(CUSTOM);
    const key =
      "workspaceId" in owner
        ? `ws:${owner.workspaceId}|${serverName}`
        : `user:${owner.userId}|${serverName}`;
    let id = this.connectorIds.get(key);
    if (!id) {
      id = this.resolveConnector(owner, serverName).then(
        (found) => found ?? CUSTOM,
        () => CUSTOM,
      );
      this.connectorIds.set(key, id);
    }
    return id;
  }

  /**
   * Whose records a run's connector source is in: a `my_` source is the
   * signed-in person's own plugin, any other the run's workspace's.
   */
  private sourceOwner(
    source: string,
    workspaceId: string | undefined,
  ): { owner: ConnectorOwner | undefined; serverName: string } {
    if (isPersonalConnectorName(source)) {
      const userId = this.telemetry.currentUserId();
      return {
        owner: userId ? { userId } : undefined,
        serverName: personalConnectorServerName(source),
      };
    }
    // A run on an external agent runtime reports its tool calls without the
    // workspace stamp; the request is bound to that one workspace either way.
    const ws = workspaceId ?? this.telemetry.currentWorkspaceId();
    return { owner: ws ? { workspaceId: ws } : undefined, serverName: source };
  }

  addBuiltinSources(names: Iterable<string>): void {
    for (const name of names) this.builtinSources.add(name);
  }

  emit(event: EngineEvent): void {
    if (!this.telemetry.isEnabled()) return;

    dispatchEngineEvent(this.handlers, event);
  }

  /** Fold an llm.done event's iteration count, latency, and token usage into the run's metrics. */
  private accumulateLlm(data: LlmDonePayload): void {
    const metrics = this.runs.get(data.runId);
    if (!metrics || data.transcriptOnly) return;

    metrics.iterations++;
    if (data.llmMs > 0) metrics.llmMs += data.llmMs;
    else metrics.untimedLlmCalls++;
    metrics.cacheTokens += data.usage.cacheReadTokens ?? 0;
    metrics.inputTokens += data.usage.inputTokens;
    metrics.outputTokens += data.usage.outputTokens;
  }

  /** Fold a tool.done event's call count and latency into the run's metrics. */
  private accumulateTool(data: ToolDonePayload): void {
    const metrics = this.runs.get(data.runId);
    if (!metrics) return;
    // A held call ran nothing: the runtime returned its tool's guidance and the
    // model calls again. It is neither a call nor a failure; the repeat is the call.
    if (data.held) return;

    metrics.toolCalls++;
    metrics.toolMs += data.ms;
    const { sourcePrefix, bareToolName, hasSeparator } = splitInnerToolName(data.name);
    const isConnector =
      hasSeparator && sourcePrefix.length > 0 && !this.builtinSources.has(sourcePrefix);
    if (isConnector) metrics.connectorToolCalls++;
    if (this.named())
      this.captureToolCalled(data, metrics, isConnector, sourcePrefix, bareToolName);
    // The agent made an automation: a kernel tool, so naming it reveals nothing.
    // On an identified deployment, `automation.created` reports every create, from any door.
    if (data.ok && data.name === "tasks__create" && !this.named())
      this.telemetry.capture("task.created");
  }

  /**
   * One tool call, named: the kernel's and platform apps' tools by their own
   * names, a catalog connector's by its catalog id and tool, anything else as
   * `custom`. Never arguments, results or error text.
   */
  private captureToolCalled(
    data: ToolDonePayload,
    metrics: RunMetrics,
    isConnector: boolean,
    source: string,
    tool: string,
  ): void {
    // The run's id joins a call to its run (`agent.chat_*`, `automation.run_completed`).
    const base = { ok: data.ok, duration_ms: data.ms, run_id: data.runId };
    if (!isConnector) {
      const kind = source === "nb" || IDENTITY_SOURCES.has(source) ? "kernel" : "app";
      this.telemetry.capture("tool.called", { ...base, source: kind, app: source, tool });
      return;
    }
    const { owner, serverName } = this.sourceOwner(source, data.workspaceId);
    const connector = this.connectorId(owner, serverName);
    metrics.connectors.add(connector);
    void connector.then((id) =>
      this.telemetry.capture("tool.called", {
        ...base,
        source: "connector",
        connector: id,
        tool: id === CUSTOM ? CUSTOM : tool,
      }),
    );
  }

  /** Start a per-run metrics accumulator and capture the chat-started event. */
  private captureRunStart(data: RunStartPayload): void {
    const metrics = createRunMetrics();
    if (this.named()) {
      metrics.model = data.model;
      metrics.trigger = this.telemetry.currentTrigger();
    }
    this.runs.set(data.runId, metrics);
    this.telemetry.capture("agent.chat_started", {
      tool_count: data.toolNames.length,
      ...(this.named() ? { run_id: data.runId } : {}),
      ...(metrics.model ? { model: metrics.model } : {}),
      ...(metrics.trigger ? { trigger: metrics.trigger } : {}),
    });
  }

  /**
   * The skills a run loaded. A skill a catalog connector published is named
   * `<catalog id>:<skill>`; any other is `custom`: a custom connector's skill,
   * and a skill someone wrote, have names people chose, and the name a
   * connector was installed under is never sent.
   */
  private recordSkills(data: SkillsLoadedPayload): void {
    if (!this.named() || !data.runId) return;
    const metrics = this.runs.get(data.runId);
    if (!metrics) return;
    for (const skill of data.skills) {
      if (!skill.connector) {
        metrics.skills.add(Promise.resolve(CUSTOM));
        continue;
      }
      const { owner, serverName } = this.sourceOwner(
        skill.connector,
        this.telemetry.currentWorkspaceId(),
      );
      metrics.skills.add(
        this.connectorId(owner, serverName).then((id) =>
          id === CUSTOM ? CUSTOM : `${id}:${skill.name}`,
        ),
      );
    }
  }

  /**
   * A connector sign-in, read from its connection's transitions: entering
   * `pending_auth` starts one, leaving it for `running` completes it, leaving
   * it any other way fails it, and `running` falling to `reauth_required` is a
   * sign-in lost. Never the error text or the authorization URL.
   */
  private captureConnectionChange(data: ConnectionStateChangedPayload): void {
    if (!this.named()) return;
    const owner = "wsId" in data ? data.wsId : data.userId;
    const key = `${owner}|${data.serverName}|${data.principalId}`;
    const previous = this.connectionStates.get(key);
    this.connectionStates.set(key, data.state);
    const event = authEventFor(previous, data.state);
    if (!event) return;
    const workspace = "wsId" in data ? data.wsId : undefined;
    // A person's own plugin is resolved from their records, a workspace's from its own.
    const records: ConnectorOwner =
      "wsId" in data ? { workspaceId: data.wsId } : { userId: data.userId };
    const connector = this.connectorId(records, data.serverName);
    void connector.then((id) =>
      this.telemetry.captureAbout(
        event,
        {
          connector: id,
          scope: workspace ? "workspace" : "personal",
          ...(event === "connector.auth_failed" ? { state: data.state } : {}),
        },
        {
          ...(workspace ? { workspaceId: workspace } : {}),
          ...("userId" in data ? { userId: data.userId } : {}),
        },
      ),
    );
  }

  /** A skill someone created: its scope only, since its name is theirs. */
  private captureSkillCreated(data: SkillCreatedPayload): void {
    if (!this.named()) return;
    this.telemetry.capture("skill.created", { scope: data.scope });
  }

  /** Capture the chat-completed event from the accumulated run metrics, then drop the accumulator. */
  private captureRunDone(data: RunDonePayload): void {
    const metrics = this.runs.get(data.runId);
    const totalMs = metrics ? Date.now() - metrics.startedAt : 0;

    // run.done event carries no token counts (it never has) — read the
    // run-level totals from the per-run metrics accumulator.
    const completed: Record<string, unknown> = {
      iterations: metrics?.iterations ?? 0,
      tool_calls: metrics?.toolCalls ?? 0,
      connector_tool_calls: metrics?.connectorToolCalls ?? 0,
      stop_reason: data.stopReason,
      // Unknown latency is left out, never reported as 0.
      ...(metrics?.untimedLlmCalls ? {} : { llm_latency_ms: metrics?.llmMs ?? 0 }),
      tool_latency_ms: metrics?.toolMs ?? 0,
      total_ms: totalMs,
      input_tokens: metrics?.inputTokens ?? 0,
      output_tokens: metrics?.outputTokens ?? 0,
      cache_tokens: metrics?.cacheTokens ?? 0,
    };
    if (!metrics || !this.named()) {
      this.telemetry.capture("agent.chat_completed", completed);
    } else {
      const { model, trigger } = metrics;
      void Promise.all([Promise.all(metrics.connectors), Promise.all(metrics.skills)]).then(
        ([connectors, skills]) =>
          this.telemetry.capture("agent.chat_completed", {
            ...completed,
            run_id: data.runId,
            model,
            ...(trigger ? { trigger } : {}),
            connectors_used: [...new Set(connectors)].sort(),
            skills_used: [...new Set(skills)].sort(),
          }),
      );
    }

    this.runs.delete(data.runId);
  }

  /**
   * Capture an agent.error with the error's class name, then drop the
   * accumulator. Never the message: it can carry user content.
   */
  private captureRunError(data: RunErrorPayload): void {
    this.telemetry.capture("agent.error", { error_type: data.type });
    this.runs.delete(data.runId);
  }

  /** Capture connector.installed with UI presence, and on identified deployments its catalog id. Every connector is remote. */
  private captureConnectorInstalled(data: ConnectorInstalledPayload): void {
    const base = { source: "remote", has_ui: Boolean(data.ui) };
    if (!this.named()) {
      this.telemetry.capture("connector.installed", base);
      return;
    }
    // A reinstall may come from a different catalog entry, so resolve afresh.
    this.connectorIds.delete(`ws:${data.wsId}|${data.serverName}`);
    void this.connectorId({ workspaceId: data.wsId }, data.serverName).then((connector) =>
      this.telemetry.capture("connector.installed", { ...base, connector }),
    );
  }

  /** Capture connector.uninstalled. */
  private captureConnectorUninstalled(): void {
    this.telemetry.capture("connector.uninstalled", { source: "remote" });
  }
}
