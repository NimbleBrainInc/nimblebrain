import { NoopEventSink } from "../adapters/noop-events.ts";
import type { BundleLifecycleManager } from "../bundles/lifecycle.ts";
import type { BundleManifest } from "../bundles/types.ts";
import { isToolEnabled, type ResolvedFeatures } from "../config/features.ts";
import type { ConfirmationGate } from "../config/privilege.ts";
import type { ServerDetail } from "../connectors/server-detail.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { EventSink, ToolPromotionControls, ToolResult, ToolSchema } from "../engine/types.ts";
import { NON_ADVANCING_META_KEY } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { SelectedSkill } from "../skills/select.ts";
import type { Skill } from "../skills/types.ts";
import { createManageAppsTool } from "./app-tools.ts";
import { createManageConnectorsTool } from "./connector-tools.ts";
import { buildCoreResourceMap } from "./core-resources/index.ts";
import { createCoreToolDefs } from "./core-source.ts";
import type { DelegateContext } from "./delegate.ts";
import { createDelegateTool } from "./delegate.ts";
import { defineInProcessApp, type InProcessTool } from "./in-process-app.ts";
import { McpSource } from "./mcp-source.ts";
import { createManageToolsToolDefs } from "./platform/manage-tools.ts";
import type { ToolRegistry } from "./registry.ts";
import { createManageRegistriesTool } from "./registry-tools.ts";
import { rankToolSearchResults } from "./search-ranking.ts";
import { createManageUsersTool, type ManageUsersContext } from "./user-tools.ts";
import {
  createManageWorkspacesTool,
  type ManageMembersContext,
  type ManageWorkspacesContext,
} from "./workspace-mgmt-tools.ts";

export type ToolPromotionContext = ToolPromotionControls;

export interface ToolEligibilityContext {
  isToolEligible(tool: ToolSchema): boolean;
}

/** Callback that returns the current loaded skills from the runtime. */
export type GetSkillsFn = () => { context: Skill[]; matchable: Skill[] };

/**
 * Factory that creates the `nb` system source as an in-process MCP server.
 * Merges core platform tools (list_apps, get_config, etc.) with system tools
 * (search, delegate, etc.) into a single "nb" source.
 *
 * Returns a started, ready-to-use source. Async because the underlying
 * `McpSource.start()` runs the SDK initialize handshake over the linked
 * `InMemoryTransport` pair before the source can serve tool calls.
 */
export async function createSystemTools(
  getRegistry: () => ToolRegistry,
  _configPath?: string,
  // Reserved slot — was the bundle-management ConfirmationGate consumed by
  // `nb__manage_app`. The tool was removed; keep the positional slot stable
  // (the file's reserved-slot convention) so every call site's arity holds.
  _gate?: ConfirmationGate,
  // Reserved slot — was the lifecycle manager for skill `requires-bundles`
  // dependency checks (removed in the manifest cutover). Keep the positional
  // slot stable so call-site arity holds.
  _lifecycle?: BundleLifecycleManager,
  delegateCtx?: DelegateContext,
  // skillDir + reloadSkills were here for the legacy `nb__manage_skill`
  // tool. Mutation now lives in the dedicated `nb__skills` source — keep
  // these slots reserved (typed `unknown`) so call-site arity stays stable
  // and runtime.ts doesn't need a coordinated edit. Prune both when the
  // next signature shake-up lands.
  _legacySkillDir?: string,
  _legacyReloadSkills?: () => Promise<void>,
  getSkills?: GetSkillsFn,
  eventSink?: EventSink,
  features?: ResolvedFeatures,
  runtime?: Runtime,
  // Reserved slot — was the mpak SDK home for the legacy searchBundles
  // discovery path. Registry search now goes through
  // ConnectorDirectory.servers() (Browse's own cached, scoped fetch), which
  // manages its own client. Keep the positional slot stable so every call
  // site's arity holds.
  _mpakHome?: string,
  manageUsersCtx?: ManageUsersContext,
  manageWorkspacesCtx?: ManageWorkspacesContext,
  manageMembersCtx?: ManageMembersContext,
  // Reserved slot — was the workspace-scoped bundle-management context for
  // `nb__manage_app` (removed). Kept (typed `unknown`) to hold the positional
  // slot stable for every call site. Prune on the next signature shake-up.
  _manageBundleCtx?: unknown,
  toolPromotionCtx?: ToolPromotionContext,
  toolEligibilityCtx?: ToolEligibilityContext,
): Promise<McpSource> {
  // Core tools (always available, not feature-gated)
  const coreToolDefs: InProcessTool[] = runtime ? createCoreToolDefs(runtime) : [];
  const manageToolsToolDefs: InProcessTool[] = createManageToolsToolDefs(toolPromotionCtx);

  const systemToolDefs: InProcessTool[] = [
    {
      name: "search",
      description:
        "Search installed tools by keyword (scope: tools) or the mpak registry for bundles to install (scope: registry). Returns matches as a list; to call a matched tool, activate it first with nb__manage_tools.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["tools", "registry"],
            description: "Search installed tools or the mpak registry for new bundles.",
          },
          query: {
            type: "string",
            description:
              "Search query (natural-language terms over name + description). Optional — omit to list everything in scope.",
          },
        },
        required: ["scope"],
      },
      handler: async (input): Promise<ToolResult> => {
        const scope = String(input.scope ?? "tools");
        const query = String(input.query ?? "");

        // Runtime feature flag checks (tool is always registered, scope is gated)
        const gateError = checkSearchScopeGate(scope, features);
        if (gateError) return gateError;

        if (scope === "registry") {
          return searchRegistry(runtime, query);
        }
        // scope === "tools" (default)
        return searchTools(runtime, getRegistry, toolEligibilityCtx, query);
      },
    },
    createReadResourceTool(getRegistry),
    createStatusTool(getRegistry, getSkills, runtime),
  ];

  if (delegateCtx) {
    systemToolDefs.push(createDelegateTool(delegateCtx));
  }

  if (manageUsersCtx) {
    systemToolDefs.push(createManageUsersTool(manageUsersCtx));
  }

  if (manageWorkspacesCtx) {
    // Merge member context into the workspace tool. The conversation
    // context was removed in Stage 1's schema purge (share/unshare/
    // participant actions are gone — `manage_workspaces` no longer
    // needs a conversation store).
    const mergedCtx = {
      ...manageWorkspacesCtx,
      ...(manageMembersCtx ? { userStore: manageMembersCtx.userStore } : {}),
    };
    systemToolDefs.push(createManageWorkspacesTool(mergedCtx));
  }

  // Connectors tool. Single surface for all connectors — the install
  // destination is the request's active workspace (personal or shared),
  // and disconnects look up the binding workspace from the installed ref.
  if (runtime && manageWorkspacesCtx) {
    systemToolDefs.push(
      createManageConnectorsTool({
        runtime,
        getIdentity: manageWorkspacesCtx.getIdentity,
        // Workspace id is per-call — pull from the runtime's current
        // workspace context to know which workspace's bundles[] to mutate.
        getWorkspaceId: () => runtime.getCurrentWorkspaceId(),
      }),
    );
    systemToolDefs.push(
      createManageRegistriesTool({
        runtime,
        getIdentity: manageWorkspacesCtx.getIdentity,
      }),
    );
    // Org-scoped app version management (org_admin). Separate from the
    // per-workspace `manage_connectors` because an app's version is global
    // (shared name-keyed mpak cache) — see app-tools.ts.
    systemToolDefs.push(
      createManageAppsTool({
        runtime,
        getIdentity: manageWorkspacesCtx.getIdentity,
      }),
    );
  }

  // Filter out system tools whose feature flag is disabled.
  // Tools not in FEATURE_TOOL_MAP (e.g., bundle_status, skill_status) always pass.
  // Core tools are never feature-gated — they are always available.
  const filteredSystemDefs = features
    ? systemToolDefs.filter((t) => isToolEnabled(t.name, features))
    : systemToolDefs;

  const source = defineInProcessApp(
    {
      name: "nb",
      version: "1.0.0",
      tools: [...coreToolDefs, ...manageToolsToolDefs, ...filteredSystemDefs],
      resources: buildCoreResourceMap(),
    },
    eventSink ?? new NoopEventSink(),
  );
  await source.start();
  return source;
}

// ---------------------------------------------------------------------------
// status tool (universal read — replaces bundle_status + skill_status)
// ---------------------------------------------------------------------------

/** Core skills ship with the package under src/skills/core/. */
const CORE_SKILL_MARKER = "/skills/core/";

/** Maximum characters returned from a single read_resource call.
 *  Matches the focused-app skill budget so a bundle-advertised `skill://` resource
 *  fits into the LLM's context without blowing past it. */
const READ_RESOURCE_MAX_CHARS = 12_000;

/**
 * Creates the nb__read_resource system tool.
 *
 * Walks every `McpSource` in the current workspace registry and returns the
 * first one that resolves the URI. This lets the LLM consume `skill://` and
 * `ui://` URIs referenced in an app's `<app-instructions>` block. After the
 * platform unified on MCP-everywhere (issue #90), every source is an
 * `McpSource` with a uniform `readResource(uri): Promise<ResourceData|null>`
 * — no shape divergence, no type-guard duck-typing.
 */
function createReadResourceTool(getRegistry: () => ToolRegistry): InProcessTool {
  return {
    name: "read_resource",
    description:
      "Read a resource published by an installed app or by the platform. Use this when an app's instructions tell you to load a specific resource, or when you need to inspect platform-published context (e.g. saved overlay instructions). Supported URI schemes include `skill://`, `ui://`, `instructions://`, and any bundle-published scheme matching the bundle's source name. Pass the full URI; the content comes back as text in the tool result.",
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description:
            "Resource URI to read (e.g. skill://myapp/SKILL.md, ui://myapp/guide, instructions://workspace, <bundle>://instructions).",
        },
      },
      required: ["uri"],
    },
    handler: async (input): Promise<ToolResult> => {
      const uri = typeof input.uri === "string" ? input.uri.trim() : "";
      if (!uri) {
        return { content: textContent("uri is required"), isError: true };
      }

      const registry = getRegistry();
      const errors: string[] = [];
      for (const source of registry.getSources()) {
        if (!(source instanceof McpSource)) continue;
        const found = await readResourceFromSource(source, uri, errors);
        if (found) return found;
      }

      const detail = errors.length ? ` Errors: ${errors.join("; ")}` : "";
      return {
        content: textContent(`Resource "${uri}" not found in any installed app.${detail}`),
        isError: true,
      };
    },
  };
}

/**
 * Read `uri` from one McpSource. Returns the formatted result when the source
 * resolves it, or null to keep scanning (unresolved, or a fetch error recorded
 * into `errors`).
 */
async function readResourceFromSource(
  source: McpSource,
  uri: string,
  errors: string[],
): Promise<ToolResult | null> {
  try {
    const data = await source.readResource(uri);
    if (data == null) return null;
    if (typeof data.text === "string") {
      return formatResourceText(data.text);
    }
    if (data.blob) {
      return {
        content: textContent(
          `[binary resource, ${data.blob.length} bytes, mimeType=${data.mimeType ?? "unknown"}]`,
        ),
        isError: false,
      };
    }
    return null;
  } catch (err) {
    errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Format a text resource body, truncating past READ_RESOURCE_MAX_CHARS. */
function formatResourceText(full: string): ToolResult {
  const truncated = full.length > READ_RESOURCE_MAX_CHARS;
  const body = truncated
    ? `${full.slice(0, READ_RESOURCE_MAX_CHARS)}\n\n[truncated — resource exceeds ${READ_RESOURCE_MAX_CHARS} chars]`
    : full;
  return { content: textContent(body), isError: false };
}

/**
 * Creates the unified nb__status tool that replaces bundle_status and skill_status.
 * Aggregates data from the registry, skills, and runtime config into one read-only tool.
 */
function createStatusTool(
  getRegistry: () => ToolRegistry,
  getSkills?: GetSkillsFn,
  runtime?: Runtime,
): InProcessTool {
  return {
    name: "status",
    description:
      "Get platform status. Default scope shows a concise overview. Use 'bundles' for per-app health, 'skills' for loaded skills, or 'config' for model and limit details.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["overview", "bundles", "skills", "config"],
          description:
            "What to report. 'overview' (default): concise self-portrait. 'bundles': per-app health/version. 'skills': loaded skills by category. 'config': model slots, providers, limits.",
        },
        name: {
          type: "string",
          description: "Optional name to get detail for a specific bundle or skill.",
        },
      },
    },
    handler: async (input): Promise<ToolResult> => {
      const scope = String(input.scope ?? "overview");
      const nameQuery = input.name ? String(input.name) : null;

      try {
        return await resolveStatusScope(scope, nameQuery, getRegistry, getSkills, runtime);
      } catch (err) {
        return {
          content: textContent(
            `Failed to get status: ${err instanceof Error ? err.message : String(err)}`,
          ),
          isError: true,
        };
      }
    },
  };
}

/** Dispatch a `status` call to the handler for its scope (default: overview). */
async function resolveStatusScope(
  scope: string,
  nameQuery: string | null,
  getRegistry: () => ToolRegistry,
  getSkills: GetSkillsFn | undefined,
  runtime: Runtime | undefined,
): Promise<ToolResult> {
  if (scope === "bundles") {
    return handleBundleStatus(getRegistry, nameQuery);
  }
  if (scope === "skills") {
    const wsId = runtime?.requireWorkspaceId();
    if (!runtime || !wsId) {
      return { content: textContent("Skill status not available."), isError: false };
    }
    return handleSkillStatus(runtime, getSkills, nameQuery, wsId);
  }
  if (scope === "config") {
    return handleConfigStatus(runtime);
  }
  return handleOverviewStatus(getRegistry, getSkills, runtime);
}

async function handleBundleStatus(
  getRegistry: () => ToolRegistry,
  nameQuery: string | null,
): Promise<ToolResult> {
  const query = nameQuery?.toLowerCase() ?? null;
  const sources = getRegistry().getSources();
  const entries: string[] = [];

  for (const source of sources) {
    const entry = await buildBundleStatusEntry(source, query);
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    return {
      content: textContent(
        query ? `No installed app matches "${query}".` : "No apps are currently installed.",
      ),
      isError: false,
    };
  }
  return { content: textContent(entries.join("\n\n")), isError: false };
}

/**
 * Best-effort tool count for a status entry. Per-source error containment —
 * the same guard `registry.availableTools` applies. A source in `starting` /
 * `pending_auth` / `dead` state has `client === null` and throws
 * `"<name>" not started` from `tools()`. A status call is exactly where a down
 * connector must be REPORTED, not where it aborts the whole report: without
 * this guard one dead source's throw rejects `nb__status(scope="bundles")` for
 * every connector (the tool's top-level catch then replaces the entire report
 * with that one error). Returns null when the count is unknowable so the caller
 * omits the Tools line rather than fabricating `Tools: 0` for a live-but-down
 * connector; the `Status: down` line (via `isAlive()`) carries the real signal.
 */
async function safeToolCount(
  source: ReturnType<ToolRegistry["getSources"]>[number],
): Promise<number | null> {
  try {
    return (await source.tools()).length;
  } catch (err) {
    log.warn(
      `[status] could not enumerate tools for "${source.name}" — ` +
        `${err instanceof Error ? err.message : String(err)}. Reporting it as down.`,
    );
    return null;
  }
}

/** Format one bundle's status block, or null when the source is filtered out. */
async function buildBundleStatusEntry(
  source: ReturnType<ToolRegistry["getSources"]>[number],
  query: string | null,
): Promise<string | null> {
  const serverName = source.name;
  if (!query && !(source instanceof McpSource)) return null;
  if (query && !serverName.toLowerCase().includes(query)) return null;

  const toolCount = await safeToolCount(source);
  const manifest = await readManifestForSource(serverName);

  const lines: string[] = [];
  lines.push(`**${manifest?.name ?? serverName}**`);
  if (manifest?.version) lines.push(`  Version: ${manifest.version}`);
  if (manifest?.description) lines.push(`  Description: ${manifest.description}`);
  if (manifest?.author?.name) lines.push(`  Author: ${manifest.author.name}`);
  // Omit the Tools line when enumeration failed — a dead source's true tool
  // count is unknowable here (the memo is cleared on teardown), and rendering
  // `Tools: 0` would read as "empty connector" rather than "down".
  if (toolCount !== null) lines.push(`  Tools: ${toolCount}`);

  if (source instanceof McpSource) {
    const alive = source.isAlive();
    const uptime = source.uptime();
    lines.push(`  Status: ${alive ? "healthy" : "down"}`);
    if (uptime !== null) lines.push(`  Uptime: ${formatUptime(uptime)}`);
  }

  return lines.join("\n");
}

async function handleSkillStatus(
  runtime: Runtime,
  getSkills: GetSkillsFn | undefined,
  nameQuery: string | null,
  wsId: string,
): Promise<ToolResult> {
  // Report through the SAME per-request path `chat` composes with
  // (`describeRequestSkills` → `selectRequestLayer3`), so workspace- and
  // user-tier skills that actually load into the prompt appear here — the old
  // path read a boot-time cache and reported only platform/core skills.
  const { context, layer3 } = await runtime.describeRequestSkills(wsId);
  // Legacy trigger-matched skills still come from the boot matcher cache.
  const matchable = getSkills?.().matchable ?? [];
  const layer3Names = new Set(layer3.map((s) => s.skill.manifest.name));

  // Single skill detail view
  if (nameQuery) {
    return skillDetailResult(context, layer3, matchable, nameQuery);
  }

  // Overview: categorize all skills
  const coreContext = context.filter((s) => s.sourcePath.includes(CORE_SKILL_MARKER));
  const coreNames = new Set(coreContext.map((s) => s.manifest.name));
  // Non-core boot context skills, minus any that ALSO surface in the
  // per-request Layer-3 set below — otherwise the same skill lists twice.
  const userContext = context.filter(
    (s) => !s.sourcePath.includes(CORE_SKILL_MARKER) && !layer3Names.has(s.manifest.name),
  );
  // A skill already shown under "Core Skills (immutable)" is not repeated in
  // the Layer-3 sections — Core is authoritative. Deduped BY NAME (not by a
  // `/skills/core/` path marker), so a non-core skill that merely lives under
  // a `core/` subfolder keeps its own name and is never wrongly hidden.
  // Layer 3 is the conditional channel: only tool-affinity skills load here.
  // `always` skills compose into the context channel (shown in the sections above).
  const toolAffined = layer3.filter((s) => !coreNames.has(s.skill.manifest.name));

  const sections = [
    buildSkillSection("## Core Skills (immutable)", coreContext, formatSkillSummary),
    buildSkillSection("## User Context Skills (always active)", userContext, formatSkillSummary),
    buildSkillSection("## Tool-Affined Skills (active)", toolAffined, formatLayer3Summary),
    buildSkillSection("## Matchable Skills (triggered)", matchable, formatMatchableSummary),
  ].filter((s): s is string => s !== null);

  if (sections.length === 0) {
    return { content: textContent("No skills loaded."), isError: false };
  }
  return { content: textContent(sections.join("\n\n")), isError: false };
}

/** Single-skill detail view for status(scope="skills", name=...). */
function skillDetailResult(
  context: readonly Skill[],
  layer3: readonly SelectedSkill[],
  matchable: readonly Skill[],
  nameQuery: string,
): ToolResult {
  const all = [...context, ...layer3.map((s) => s.skill), ...matchable];
  const skill = all.find((s) => s.manifest.name.toLowerCase() === nameQuery.toLowerCase());
  if (!skill) {
    return {
      content: textContent(
        `No skill found with name "${nameQuery}". Use status with scope "skills" to list all.`,
      ),
      isError: true,
    };
  }
  return { content: textContent(formatSkillDetail(skill)), isError: false };
}

/** Build a "## Heading" + formatted-line section, or null when there's nothing to show. */
function buildSkillSection<T>(
  heading: string,
  items: T[],
  format: (item: T) => string,
): string | null {
  if (items.length === 0) return null;
  const lines = [heading];
  for (const item of items) lines.push(format(item));
  return lines.join("\n");
}

function handleConfigStatus(runtime?: Runtime): ToolResult {
  if (!runtime) {
    return { content: textContent("Config status not available."), isError: false };
  }
  const models = runtime.getModelSlots();
  const defaultModel = runtime.getDefaultModel();
  const configuredProviders = runtime.getConfiguredProviders();
  const maxIterations = runtime.getMaxIterations();
  const maxInputTokens = runtime.getMaxInputTokens();
  const maxOutputTokens = runtime.getMaxOutputTokens();

  const lines = [
    "## Configuration",
    `Default model: ${defaultModel}`,
    `Model slots: ${Object.entries(models)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
    `Providers: ${configuredProviders.join(", ")}`,
    `Max iterations: ${maxIterations}`,
    `Max input tokens: ${maxInputTokens.toLocaleString()}`,
    `Max output tokens: ${maxOutputTokens.toLocaleString()}`,
  ];
  return { content: textContent(lines.join("\n")), isError: false };
}

async function handleOverviewStatus(
  getRegistry: () => ToolRegistry,
  getSkills?: GetSkillsFn,
  runtime?: Runtime,
): Promise<ToolResult> {
  const lines: string[] = ["## Platform Status"];

  // Version
  if (runtime) {
    lines.push(`Model: ${runtime.getDefaultModel()}`);
    lines.push(`Max iterations: ${runtime.getMaxIterations()}`);
  }

  // App count
  const sources = getRegistry().getSources();
  const appSources = sources.filter((s) => s instanceof McpSource);
  const platformSources = sources.filter((s) => !(s instanceof McpSource) && s.name !== "nb");
  if (appSources.length > 0 || platformSources.length > 0) {
    const healthy = appSources.filter((s) => (s as McpSource).isAlive()).length;
    const parts: string[] = [];
    if (platformSources.length > 0) parts.push(`${platformSources.length} platform`);
    if (appSources.length > 0) parts.push(`${appSources.length} external (${healthy} healthy)`);
    lines.push(`Apps: ${parts.join(", ")}`);
  } else {
    lines.push("Apps: none installed");
  }

  // Skill count
  if (getSkills) {
    const { context, matchable } = getSkills();
    lines.push(`Skills: ${context.length} context, ${matchable.length} matchable`);
  }

  return { content: textContent(lines.join("\n")), isError: false };
}

function formatSkillSummary(skill: Skill): string {
  const m = skill.manifest;
  return `- ${m.name} (${m.loadingStrategy}, priority ${m.priority}) — ${m.description || "(no description)"}`;
}

/** Summary line for a per-request Layer-3 skill, including why it loaded. */
function formatLayer3Summary(selected: SelectedSkill): string {
  const m = selected.skill.manifest;
  const scope = m.scope ?? "org";
  return `- ${m.name} (${scope}, priority ${m.priority}) — ${m.description || "(no description)"}\n  Loaded: ${selected.reason}`;
}

function formatMatchableSummary(skill: Skill): string {
  const m = skill.manifest;
  const lines = [
    `- ${m.name} (${m.loadingStrategy}, priority ${m.priority}) — ${m.description || "(no description)"}`,
  ];
  const triggers = m.triggers ?? [];
  if (triggers.length > 0) {
    lines.push(`  Triggers: ${triggers.map((t) => `"${t}"`).join(", ")}`);
  }
  return lines.join("\n");
}

function formatSkillDetail(skill: Skill): string {
  const m = skill.manifest;
  const isCore = skill.sourcePath.includes(CORE_SKILL_MARKER);
  const lines = [
    `**${m.name}** (${m.loadingStrategy}${isCore ? ", core — immutable" : ""})`,
    `Description: ${m.description || "(none)"}`,
    `Priority: ${m.priority}`,
    `Source: ${skill.sourcePath}`,
  ];
  if (m.version) lines.push(`Version: ${m.version}`);
  if (m.allowedTools && m.allowedTools.length > 0)
    lines.push(`Allowed tools: ${m.allowedTools.join(", ")}`);
  if (m.toolAffinity && m.toolAffinity.length > 0)
    lines.push(`Tool affinity: ${m.toolAffinity.join(", ")}`);
  if (m.triggers && m.triggers.length > 0)
    lines.push(`Triggers: ${m.triggers.map((t) => `"${t}"`).join(", ")}`);

  lines.push("", "---", "", skill.body);

  return lines.join("\n");
}

/** Read a cached manifest by server name, trying common mpak cache paths. */
async function readManifestForSource(serverName: string): Promise<BundleManifest | null> {
  try {
    const { existsSync, readFileSync, readdirSync } = require("node:fs");
    const { join } = require("node:path");
    const { homedir } = require("node:os");
    const cacheDir = join(homedir(), ".mpak", "cache");
    if (!existsSync(cacheDir)) return null;

    // Find a cache entry whose name ends with the server name
    // e.g., serverName "granola" matches "nimblebraininc-granola"
    const entries = readdirSync(cacheDir) as string[];
    const match = entries.find(
      (e: string) =>
        e === serverName ||
        e.endsWith(`-${serverName}`) ||
        e.replace(/-/g, "").includes(serverName.replace(/-/g, "")),
    );
    if (!match) return null;

    const manifestPath = join(cacheDir, match, "manifest.json");
    if (!existsSync(manifestPath)) return null;
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as BundleManifest;
  } catch {
    return null;
  }
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Keyword match over an mpak `ServerDetail` set for agent registry search.
 * Empty query returns everything; otherwise every whitespace-separated term
 * must appear (case-insensitive) in the name, title, description, or a
 * package identifier.
 *
 * NOTE: this is DELIBERATELY a different matcher from the web Browse search
 * box, not a port of it. Browse OR-matches the whole query as one literal
 * substring across name/description/tags; this AND-matches each term across
 * more fields — better precision for an agent narrowing to a specific
 * bundle. They are not meant to return identical sets. No shared backend
 * matcher exists; if you change the field set here, that divergence is
 * expected, not a bug.
 */
function matchServersByQuery(servers: ServerDetail[], query: string): ServerDetail[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return servers;
  return servers.filter((s) => {
    const hay = [
      s.name,
      s.title ?? "",
      s.description,
      ...(s.packages ?? []).map((p) => p.identifier),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

function groupToolsBySource(all: Array<{ name: string; description: string }>): ToolResult {
  const groups = new Map<string, string[]>();
  for (const tool of all) {
    const prefix = tool.name.split("__")[0] ?? "unknown";
    const names = groups.get(prefix) ?? [];
    names.push(tool.name);
    groups.set(prefix, names);
  }
  const lines = ["Available tools:\n"];
  for (const [source, names] of groups) {
    lines.push(`**${source}** (${names.length} tools): ${names.join(", ")}`);
  }
  return {
    content: textContent(lines.join("\n")),
    structuredContent: { tools: all.map((t) => ({ name: t.name })) },
    isError: false,
  };
}

/** Feature-flag gate for `search`: an error result when the scope is disabled, else null. */
function checkSearchScopeGate(scope: string, features?: ResolvedFeatures): ToolResult | null {
  if (scope === "tools" && features && !features.toolDiscovery) {
    return { content: textContent("Tool discovery is disabled."), isError: true };
  }
  if (scope === "registry" && features && !features.bundleDiscovery) {
    return { content: textContent("Bundle discovery is disabled."), isError: true };
  }
  return null;
}

/** `search` scope=registry — keyword-match mpak bundles from the connector directory. */
async function searchRegistry(runtime: Runtime | undefined, query: string): Promise<ToolResult> {
  try {
    // Route agent discovery through the SAME method Browse uses —
    // ConnectorDirectory.servers(). It fetches every enabled source,
    // applies each registry's OWN scopes per-source (so mixed-scope
    // multi-registry configs filter exactly as Browse does), runs
    // the icon/URL safety scrub, caches, and aggregates errors. We
    // take just the mpak-sourced bundles and keyword-match them. One
    // method, not two parallel fetch/filter paths, so the scope
    // filtering can't drift.
    //
    // No runtime (non-agent/test paths) ⇒ no directory ⇒ no results;
    // the production agent always has one.
    const directory = runtime?.getConnectorDirectory();
    const aggregated = directory ? await directory.servers() : null;
    const mpakBundles = (aggregated?.servers ?? [])
      .filter((s) => s.source.type === "mpak")
      .map((s) => s.detail);
    const results = matchServersByQuery(mpakBundles, query);
    if (results.length === 0) {
      // Distinguish "registry unreachable" from "no such bundle".
      // servers() aggregates per-source fetch failures into `errors`
      // instead of throwing, so an mpak outage (5xx / timeout / DNS)
      // yields zero bundles silently. If an mpak source errored and we
      // got nothing back, surface a failure — matching the
      // pre-refactor throw — rather than telling the agent the bundle
      // doesn't exist.
      const mpakIds = new Set(
        (await runtime?.getRegistryStore().list())
          ?.filter((r) => r.type === "mpak")
          .map((r) => r.id),
      );
      // `mpakBundles.length === 0` is global across all mpak rows:
      // with multiple mpak registries where one is up (returning
      // bundles) and the down one held the queried bundle, this
      // reports "No bundles found" rather than a failure. Acceptable —
      // it matches Browse's partial-results semantics, and a single
      // mpak registry is the norm.
      const mpakDown =
        mpakBundles.length === 0 &&
        (aggregated?.errors ?? []).some((e) => mpakIds.has(e.registryId));
      if (mpakDown)
        return {
          content: textContent(`Failed to search mpak registry for "${query}".`),
          isError: true,
        };
      return {
        content: textContent(`No bundles found for "${query}".`),
        isError: false,
      };
    }
    const lines = [`Found ${results.length} result(s) for "${query}":\n`];
    for (const r of results) {
      const id = r.packages?.[0]?.identifier ?? r.name;
      lines.push(`- **${id}** ${r.version} [bundle]: ${r.description ?? ""}`);
    }
    return { content: textContent(lines.join("\n")), isError: false };
  } catch {
    return {
      content: textContent(`Failed to search mpak registry for "${query}".`),
      isError: true,
    };
  }
}

/**
 * `search` scope=tools — rank installed tools by keyword over the identity's
 * full cross-workspace union. Returns matches as DATA only; never mutates the
 * active tool set.
 */
async function searchTools(
  runtime: Runtime | undefined,
  getRegistry: () => ToolRegistry,
  toolEligibilityCtx: ToolEligibilityContext | undefined,
  query: string,
): Promise<ToolResult> {
  const q = query.toLowerCase().trim();
  // Identity-level discovery: search the identity's full
  // cross-workspace tool union (the aggregator), not just the
  // calling workspace. The aggregator namespaces nb__search per
  // workspace, so the model may invoke any workspace's copy — all
  // must see everything the identity can reach, else a tool
  // installed in another workspace (e.g. a CRM in ws_mat) is
  // invisible to this copy. Falls back to the current workspace
  // when there's no identity in scope (non-identity-bound paths).
  const discoverable = runtime
    ? await runtime.listDiscoverableTools()
    : await getRegistry().availableTools();
  const all = discoverable.filter(
    (t) => toolEligibilityCtx?.isToolEligible(t) ?? !t.annotations?.["ai.nimblebrain/internal"],
  );
  if (!q) return groupToolsBySource(all);
  const matches = rankToolSearchResults(all, q);
  if (matches.length === 0)
    // Mark non-advancing (out-of-band, via `_meta`) so repeated empty
    // searches trip the loop supervisor even as the model varies the
    // query each call — which otherwise yields a fresh fingerprint every
    // time and never trips.
    return {
      content: textContent(`No tools matched "${query}".`),
      isError: false,
      _meta: { [NON_ADVANCING_META_KEY]: true },
    };
  const shown = matches.slice(0, 10);
  // Return matches as DATA only — search never mutates the active tool
  // set. Tool definitions are wire position 0 (before system and
  // history), so adding one rewrites the whole cached prefix on the next
  // call. Promoting speculatively pays that rewrite for tools the model
  // may never call; instead the model activates a tool it commits to
  // using via nb__manage_tools — one append-only round-trip (reads the
  // warm prefix, writes a small delta) in place of a speculative
  // full-prefix rewrite. This result rides the message tail, the
  // cache-safe channel.
  const suffix = matches.length > shown.length ? ` (showing top ${shown.length})` : "";
  const lines = [`Found ${matches.length} tool(s) for "${query}"${suffix}:\n`];
  // One terse line per match — first line of the description, capped. The full
  // schema is surfaced only when the model activates a tool via
  // nb__manage_tools, so carrying full descriptions for every match here just
  // bloats each subsequent turn's context for tools the model won't call.
  for (const t of shown) {
    // First non-empty line, so a description that opens with a blank line
    // still renders text (not just the tool name). `find` can return
    // undefined, so the fallback is load-bearing.
    const desc = ((t.description ?? "").split("\n").find((l) => l.trim()) ?? "").trim();
    lines.push(`- **${t.name}**: ${desc.length > 100 ? `${desc.slice(0, 100)}…` : desc}`);
  }
  lines.push(
    "\nTo call one, activate it with nb__manage_tools first (that surfaces its full schema).",
  );
  return {
    content: textContent(lines.join("\n")),
    structuredContent: { tools: shown.map((t) => ({ name: t.name })) },
    isError: false,
  };
}
