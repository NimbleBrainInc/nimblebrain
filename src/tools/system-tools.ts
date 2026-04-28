import { NoopEventSink } from "../adapters/noop-events.ts";
import type { BundleLifecycleManager } from "../bundles/lifecycle.ts";
import { getMpak } from "../bundles/mpak.ts";
import { deriveServerName } from "../bundles/paths.ts";
import { startBundleSource } from "../bundles/startup.ts";
import type { BundleManifest } from "../bundles/types.ts";
import {
  installBundleInWorkspace,
  uninstallBundleFromWorkspace,
} from "../bundles/workspace-ops.ts";
import { isToolEnabled, type ResolvedFeatures } from "../config/features.ts";
import type { ConfirmationGate } from "../config/privilege.ts";
import { resolveUserConfig } from "../config/workspace-credentials.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../engine/types.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { Skill } from "../skills/types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { ManageConversationContext } from "./conversation-tools.ts";
import { buildCoreResourceMap } from "./core-resources/index.ts";
import { createCoreToolDefs } from "./core-source.ts";
import type { DelegateContext } from "./delegate.ts";
import { createDelegateTool } from "./delegate.ts";
import { defineInProcessApp, type InProcessTool } from "./in-process-app.ts";
import { McpSource } from "./mcp-source.ts";
import type { ToolRegistry } from "./registry.ts";
import { createManageUsersTool, type ManageUsersContext } from "./user-tools.ts";
import {
  createManageWorkspacesTool,
  type ManageMembersContext,
  type ManageWorkspacesContext,
} from "./workspace-mgmt-tools.ts";

/** Context for workspace-aware bundle management. */
export interface ManageBundleContext {
  getWorkspaceId: () => string | null;
  workspaceStore: WorkspaceStore;
  workDir: string;
  configDir: string | undefined;
  allowInsecureRemotes?: boolean;
  // Required — threaded into any McpSource spawned by this context so
  // task-augmented tool progress reaches the SSE broadcast path. The
  // manage_app install/configure flow spawns bundles the same way the
  // platform does at boot; both paths need the live runtime sink.
  eventSink: EventSink;
}

/** Callback that returns the current loaded skills from the runtime. */
export type GetSkillsFn = () => { context: Skill[]; matchable: Skill[] };

/**
 * Factory that creates the `nb` system source as an in-process MCP server.
 * Merges core platform tools (list_apps, get_config, etc.) with system tools
 * (search, manage_app, delegate, etc.) into a single "nb" source.
 *
 * Returns a started, ready-to-use source. Async because the underlying
 * `McpSource.start()` runs the SDK initialize handshake over the linked
 * `InMemoryTransport` pair before the source can serve tool calls.
 */
export async function createSystemTools(
  getRegistry: () => ToolRegistry,
  _configPath?: string,
  gate?: ConfirmationGate,
  lifecycle?: BundleLifecycleManager,
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
  mpakHome?: string,
  manageUsersCtx?: ManageUsersContext,
  manageWorkspacesCtx?: ManageWorkspacesContext,
  manageMembersCtx?: ManageMembersContext,
  manageConversationCtx?: ManageConversationContext,
  manageBundleCtx?: ManageBundleContext,
): Promise<McpSource> {
  // Core tools (always available, not feature-gated)
  const coreToolDefs: InProcessTool[] = runtime ? createCoreToolDefs(runtime) : [];

  const systemToolDefs: InProcessTool[] = [
    {
      name: "search",
      description:
        "Search installed tools by keyword, or search the mpak registry for bundles to install.",
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
              "Search query (substring match on name + description). Optional — omit to list everything in scope.",
          },
        },
        required: ["scope"],
      },
      handler: async (input): Promise<ToolResult> => {
        const scope = String(input.scope ?? "tools");
        const query = String(input.query ?? "");

        // Runtime feature flag checks (tool is always registered, scope is gated)
        if (scope === "tools" && features && !features.toolDiscovery) {
          return { content: textContent("Tool discovery is disabled."), isError: true };
        }
        if (scope === "registry" && features && !features.bundleDiscovery) {
          return { content: textContent("Bundle discovery is disabled."), isError: true };
        }

        if (scope === "registry") {
          try {
            const mpak = getMpak(mpakHome!);
            const data = await mpak.client.searchBundles({ q: query });
            const results = data.bundles ?? [];
            if (results.length === 0)
              return {
                content: textContent(`No bundles found for "${query}".`),
                isError: false,
              };
            const lines = [`Found ${results.length} result(s) for "${query}":\n`];
            for (const r of results) {
              lines.push(`- **${r.name}** ${r.latest_version} [bundle]: ${r.description ?? ""}`);
            }
            return { content: textContent(lines.join("\n")), isError: false };
          } catch {
            return {
              content: textContent(`Failed to search mpak registry for "${query}".`),
              isError: true,
            };
          }
        }

        // scope === "tools" (default)
        const q = query.toLowerCase();
        const all = await getRegistry().availableTools();
        if (!q) return groupToolsBySource(all);
        const matches = all.filter(
          (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
        );
        if (matches.length === 0)
          return { content: textContent(`No tools matched "${query}".`), isError: false };
        const lines = [`Found ${matches.length} tool(s) for "${query}":\n`];
        for (const t of matches) lines.push(`- **${t.name}**: ${t.description}`);
        return { content: textContent(lines.join("\n")), isError: false };
      },
    },
    {
      name: "manage_app",
      description:
        "Install, uninstall, or configure an app. 'configure' prompts for API keys/credentials securely via the terminal. Requires user approval.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["install", "uninstall", "configure"],
            description: "Action: install, uninstall, or configure (set credentials)",
          },
          name: {
            type: "string",
            description: "Bundle name (e.g., @nimblebraininc/ipinfo)",
          },
        },
        required: ["action", "name"],
      },
      handler: async (input): Promise<ToolResult> => {
        const action = String(input.action);
        const name = String(input.name);
        if (!lifecycle || !manageBundleCtx) {
          return {
            content: textContent("Bundle management requires lifecycle context"),
            isError: true,
          };
        }
        const wsId = manageBundleCtx.getWorkspaceId();
        if (!wsId) {
          return {
            content: textContent("Workspace context required for bundle management"),
            isError: true,
          };
        }
        if (action === "install") {
          return await installBundleInWorkspaceViaCtx(
            name,
            wsId,
            lifecycle,
            getRegistry(),
            manageBundleCtx,
          );
        }
        if (action === "uninstall") {
          return await uninstallBundleFromWorkspaceViaCtx(
            name,
            wsId,
            lifecycle,
            getRegistry(),
            manageBundleCtx,
          );
        }
        if (action === "configure") {
          return await configureBundle(
            name,
            getRegistry(),
            manageBundleCtx.eventSink,
            wsId,
            manageBundleCtx.workDir,
            gate,
            mpakHome,
          );
        }
        return { content: textContent(`Unknown action: ${action}`), isError: true };
      },
    },
    createReadResourceTool(getRegistry),
    createStatusTool(getRegistry, getSkills, lifecycle, runtime),
  ];

  if (delegateCtx) {
    systemToolDefs.push(createDelegateTool(delegateCtx));
  }

  if (manageUsersCtx) {
    systemToolDefs.push(createManageUsersTool(manageUsersCtx));
  }

  if (manageWorkspacesCtx) {
    // Merge member and conversation contexts into the workspace tool
    const mergedCtx = {
      ...manageWorkspacesCtx,
      ...(manageMembersCtx ? { userStore: manageMembersCtx.userStore } : {}),
      ...(manageConversationCtx
        ? {
            conversationStore: manageConversationCtx.conversationStore,
            conversationEventManager: manageConversationCtx.conversationEventManager,
          }
        : {}),
    };
    systemToolDefs.push(createManageWorkspacesTool(mergedCtx));
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
      tools: [...coreToolDefs, ...filteredSystemDefs],
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
            "Resource URI to read (e.g. skill://solar5estrella/usage, ui://myapp/guide, instructions://workspace, <bundle>://instructions).",
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
        try {
          const data = await source.readResource(uri);
          if (data == null) continue;
          if (typeof data.text === "string") {
            const full = data.text;
            const truncated = full.length > READ_RESOURCE_MAX_CHARS;
            const body = truncated
              ? `${full.slice(0, READ_RESOURCE_MAX_CHARS)}\n\n[truncated — resource exceeds ${READ_RESOURCE_MAX_CHARS} chars]`
              : full;
            return { content: textContent(body), isError: false };
          }
          if (data.blob) {
            return {
              content: textContent(
                `[binary resource, ${data.blob.length} bytes, mimeType=${data.mimeType ?? "unknown"}]`,
              ),
              isError: false,
            };
          }
        } catch (err) {
          errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
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
 * Creates the unified nb__status tool that replaces bundle_status and skill_status.
 * Aggregates data from the registry, skills, and runtime config into one read-only tool.
 */
function createStatusTool(
  getRegistry: () => ToolRegistry,
  getSkills?: GetSkillsFn,
  lifecycle?: BundleLifecycleManager,
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
        if (scope === "bundles") {
          return await handleBundleStatus(getRegistry, nameQuery);
        }

        if (scope === "skills") {
          if (!getSkills) {
            return { content: textContent("Skill status not available."), isError: false };
          }
          const wsId = runtime?.requireWorkspaceId();
          if (!wsId) {
            return { content: textContent("Workspace context required."), isError: true };
          }
          return handleSkillStatus(getSkills, lifecycle, nameQuery, wsId);
        }

        if (scope === "config") {
          return handleConfigStatus(runtime);
        }

        // Default: overview
        return await handleOverviewStatus(getRegistry, getSkills, runtime);
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

async function handleBundleStatus(
  getRegistry: () => ToolRegistry,
  nameQuery: string | null,
): Promise<ToolResult> {
  const query = nameQuery?.toLowerCase() ?? null;
  const sources = getRegistry().getSources();
  const entries: string[] = [];

  for (const source of sources) {
    const serverName = source.name;
    if (!query && !(source instanceof McpSource)) continue;
    if (query && !serverName.toLowerCase().includes(query)) continue;

    const tools = await source.tools();
    const manifest = await readManifestForSource(serverName);

    const lines: string[] = [];
    lines.push(`**${manifest?.name ?? serverName}**`);
    if (manifest?.version) lines.push(`  Version: ${manifest.version}`);
    if (manifest?.description) lines.push(`  Description: ${manifest.description}`);
    if (manifest?.author?.name) lines.push(`  Author: ${manifest.author.name}`);
    lines.push(`  Tools: ${tools.length}`);

    if (source instanceof McpSource) {
      const alive = source.isAlive();
      const uptime = source.uptime();
      lines.push(`  Status: ${alive ? "healthy" : "down"}`);
      if (uptime !== null) lines.push(`  Uptime: ${formatUptime(uptime)}`);
    }

    entries.push(lines.join("\n"));
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

function handleSkillStatus(
  getSkills: GetSkillsFn,
  lifecycle: BundleLifecycleManager | undefined,
  nameQuery: string | null,
  wsId: string,
): ToolResult {
  const { context, matchable } = getSkills();

  // Single skill detail view
  if (nameQuery) {
    const all = [...context, ...matchable];
    const skill = all.find((s) => s.manifest.name.toLowerCase() === nameQuery.toLowerCase());
    if (!skill) {
      return {
        content: textContent(
          `No skill found with name "${nameQuery}". Use status with scope "skills" to list all.`,
        ),
        isError: true,
      };
    }
    return { content: textContent(formatSkillDetail(skill, lifecycle, wsId)), isError: false };
  }

  // Overview: categorize all skills
  const coreContext = context.filter((s) => s.sourcePath.includes(CORE_SKILL_MARKER));
  const userContext = context.filter((s) => !s.sourcePath.includes(CORE_SKILL_MARKER));
  const sections: string[] = [];

  if (coreContext.length > 0) {
    const lines = ["## Core Skills (immutable)"];
    for (const s of coreContext) lines.push(formatSkillSummary(s));
    sections.push(lines.join("\n"));
  }
  if (userContext.length > 0) {
    const lines = ["## User Context Skills (always active)"];
    for (const s of userContext) lines.push(formatSkillSummary(s));
    sections.push(lines.join("\n"));
  }
  if (matchable.length > 0) {
    const lines = ["## Matchable Skills (triggered)"];
    for (const s of matchable) lines.push(formatMatchableSummary(s, lifecycle, wsId));
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) {
    return { content: textContent("No skills loaded."), isError: false };
  }
  return { content: textContent(sections.join("\n\n")), isError: false };
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
  return `- ${m.name} (${m.type}, priority ${m.priority}) — ${m.description || "(no description)"}`;
}

function formatMatchableSummary(
  skill: Skill,
  lifecycle: BundleLifecycleManager | undefined,
  wsId: string,
): string {
  const m = skill.manifest;
  const lines = [
    `- ${m.name} (${m.type}, priority ${m.priority}) — ${m.description || "(no description)"}`,
  ];
  const triggers = m.metadata?.triggers ?? [];
  if (triggers.length > 0) {
    lines.push(`  Triggers: ${triggers.map((t) => `"${t}"`).join(", ")}`);
  }
  const deps = m.requiresBundles;
  if (deps && deps.length > 0) {
    const depStatuses = deps.map((dep) => {
      const serverName = deriveServerName(dep);
      const installed = lifecycle?.getInstance(serverName, wsId) != null;
      return `${dep} (${installed ? "installed" : "missing"})`;
    });
    lines.push(`  Dependencies: ${depStatuses.join(", ")}`);
  }
  return lines.join("\n");
}

function formatSkillDetail(
  skill: Skill,
  lifecycle: BundleLifecycleManager | undefined,
  wsId: string,
): string {
  const m = skill.manifest;
  const isCore = skill.sourcePath.includes(CORE_SKILL_MARKER);
  const lines = [
    `**${m.name}** (${m.type}${isCore ? ", core — immutable" : ""})`,
    `Description: ${m.description || "(none)"}`,
    `Version: ${m.version}`,
    `Priority: ${m.priority}`,
    `Source: ${skill.sourcePath}`,
  ];

  if (m.allowedTools && m.allowedTools.length > 0)
    lines.push(`Allowed tools: ${m.allowedTools.join(", ")}`);
  if (m.metadata?.triggers && m.metadata.triggers.length > 0)
    lines.push(`Triggers: ${m.metadata.triggers.map((t) => `"${t}"`).join(", ")}`);
  if (m.metadata?.keywords && m.metadata.keywords.length > 0)
    lines.push(`Keywords: ${m.metadata.keywords.join(", ")}`);
  if (m.metadata?.category) lines.push(`Category: ${m.metadata.category}`);
  if (m.metadata?.tags && m.metadata.tags.length > 0)
    lines.push(`Tags: ${m.metadata.tags.join(", ")}`);

  const deps = m.requiresBundles;
  if (deps && deps.length > 0) {
    const depStatuses = deps.map((dep) => {
      const serverName = deriveServerName(dep);
      const installed = lifecycle?.getInstance(serverName, wsId) != null;
      return `${dep} (${installed ? "installed" : "missing"})`;
    });
    lines.push(`Dependencies: ${depStatuses.join(", ")}`);
  }

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

async function configureBundle(
  name: string,
  registry: ToolRegistry,
  // Required — passed to the restarted McpSource so its task-augmented tool
  // progress events reach SSE broadcasts (Synapse useDataSync). Without it,
  // re-configuring a bundle's credentials silently breaks live updates for
  // that bundle until the next full platform restart.
  eventSink: EventSink,
  // Workspace id + work directory — required because credentials are stored
  // per-workspace (`{workDir}/workspaces/{wsId}/credentials/{bundle}.json`),
  // not globally in `~/.mpak/config.json`. Threaded from the manage_app handler.
  wsId: string,
  workDir: string,
  confirmGate?: ConfirmationGate,
  mpakHome?: string,
): Promise<ToolResult> {
  try {
    const mpak = getMpak(mpakHome!);
    const manifest = mpak.bundleCache.getBundleManifest(name) as BundleManifest | null;
    const userConfig = manifest?.user_config;

    if (!confirmGate?.supportsInteraction) {
      // Non-interactive (HTTP server mode): show exact config commands.
      // Credentials are workspace-scoped, so include `-w <wsId>` in the hint.
      if (!userConfig || Object.keys(userConfig).length === 0) {
        return { content: textContent(`${name} has no configurable credentials.`), isError: false };
      }
      const fields = Object.entries(userConfig)
        .map(
          ([key, cfg]) =>
            `  nb config set ${name} ${key}=<value> -w ${wsId}  # ${cfg.title ?? cfg.description ?? key}`,
        )
        .join("\n");
      return {
        content: textContent(
          `Cannot configure interactively in server mode. Run in your terminal:\n\n${fields}\n\nThen restart the server.`,
        ),
        isError: true,
      };
    }

    if (!userConfig || Object.keys(userConfig).length === 0) {
      return {
        content: textContent(`${name} has no configurable credentials.`),
        isError: false,
      };
    }

    // Resolve via the 3-tier workspace-scoped resolver. `forcePrompt: true`
    // re-prompts for every field so users can update existing credentials.
    // Prompted values are persisted to the workspace credential store at
    // `{workDir}/workspaces/{wsId}/credentials/{bundle-slug}.json` — no
    // round-trip through `~/.mpak/config.json`.
    await resolveUserConfig({
      bundleName: name,
      userConfigSchema: userConfig,
      wsId,
      workDir,
      gate: confirmGate,
      forcePrompt: true,
    });

    // Restart the bundle via the shared primitive — same construction path
    // as boot-time / agent install. `startBundleSource` reads the values we
    // just persisted above from the workspace credential store. If this
    // function diverges from that primitive the rest of the app silently
    // breaks (sink plumbing, PYTHONPATH, data-dir layout, user_config
    // resolution). Delegate instead: pass `wsId`+`workDir` and let
    // `startBundleSource` derive the workspace-scoped data dir itself —
    // never compute it here, or it drifts from the install-time layout
    // and Upjack entity state disappears across restarts.
    const serverName = deriveServerName(name);
    if (registry.hasSource(serverName)) {
      await registry.removeSource(serverName);
    }
    const result = await startBundleSource({ name }, registry, eventSink, undefined, {
      wsId,
      workDir,
    });

    const tools = await registry.availableTools();
    const count = tools.filter((t) => t.name.startsWith(`${result.sourceName}__`)).length;
    return {
      content: textContent(`Configured and restarted ${name}. ${count} tools available.`),
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to configure ${name}: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

/**
 * Install a bundle in a workspace: spawn with plain server name,
 * add to workspace.json bundles, seed lifecycle instance.
 */
async function installBundleInWorkspaceViaCtx(
  name: string,
  wsId: string,
  lifecycle: BundleLifecycleManager,
  registry: ToolRegistry,
  ctx: ManageBundleContext,
): Promise<ToolResult> {
  try {
    const bundleRef = { name } as import("../bundles/types.ts").BundleRef;

    // Spawn the bundle process with plain server name in workspace registry
    const entry = await installBundleInWorkspace(
      wsId,
      bundleRef,
      registry,
      ctx.eventSink,
      ctx.configDir,
      {
        allowInsecureRemotes: ctx.allowInsecureRemotes,
        workDir: ctx.workDir,
      },
    );

    // Seed lifecycle instance so it can be tracked/queried
    lifecycle.seedInstance(
      entry.serverName,
      name,
      bundleRef,
      entry.meta ?? undefined,
      wsId,
      entry.dataDir,
    );

    // Add bundle to workspace.json
    const ws = await ctx.workspaceStore.get(wsId);
    if (ws) {
      const already = ws.bundles.some((b) => "name" in b && b.name === name);
      if (!already) {
        await ctx.workspaceStore.update(wsId, {
          bundles: [...ws.bundles, { name }],
        });
      }
    }

    const tools = await registry.availableTools();
    const count = tools.filter((t) => t.name.startsWith(`${entry.serverName}__`)).length;
    return {
      content: textContent(
        `Installed ${name} in workspace ${wsId}. ${count} tools now available from ${entry.serverName}.`,
      ),
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to install ${name} in workspace ${wsId}: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

/**
 * Uninstall a bundle from a workspace: stop process,
 * remove from workspace.json bundles, remove lifecycle instance.
 */
async function uninstallBundleFromWorkspaceViaCtx(
  name: string,
  wsId: string,
  lifecycle: BundleLifecycleManager,
  registry: ToolRegistry,
  ctx: ManageBundleContext,
): Promise<ToolResult> {
  try {
    const serverName = deriveServerName(name);

    // Protected check — pass wsId to look up the workspace-scoped instance
    const instance = lifecycle.getInstance(serverName, wsId);
    if (instance?.protected) {
      throw new Error(`Cannot uninstall "${serverName}": bundle is protected`);
    }

    // Stop process and deregister from tool registry. Thread workDir so
    // the workspace credential file for this bundle is cleaned up as part
    // of uninstall (best-effort inside uninstallBundleFromWorkspace).
    await uninstallBundleFromWorkspace(wsId, name, registry, { workDir: ctx.workDir });

    // Remove lifecycle instance tracking
    if (instance) {
      lifecycle.transition(instance, "stopped");
    }
    lifecycle.removeInstance(serverName, wsId);

    // Remove bundle from workspace.json
    const ws = await ctx.workspaceStore.get(wsId);
    if (ws) {
      await ctx.workspaceStore.update(wsId, {
        bundles: ws.bundles.filter((b) => !("name" in b && b.name === name)),
      });
    }

    return {
      content: textContent(`Uninstalled ${serverName} from workspace ${wsId}.`),
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to uninstall ${name} from workspace ${wsId}: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
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
  return { content: textContent(lines.join("\n")), isError: false };
}
