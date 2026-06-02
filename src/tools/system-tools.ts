import { NoopEventSink } from "../adapters/noop-events.ts";
import type { BundleLifecycleManager } from "../bundles/lifecycle.ts";
import { getMpak } from "../bundles/mpak.ts";
import { deriveServerName } from "../bundles/paths.ts";
import type { BundleManifest } from "../bundles/types.ts";
import { isToolEnabled, type ResolvedFeatures } from "../config/features.ts";
import type { ConfirmationGate } from "../config/privilege.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { EventSink, ToolPromotionControls, ToolResult, ToolSchema } from "../engine/types.ts";
import { NON_ADVANCING_META_KEY } from "../engine/types.ts";
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
              "Search query (natural-language terms over name + description). Optional — omit to list everything in scope.",
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
          (t) =>
            toolEligibilityCtx?.isToolEligible(t) ?? !t.annotations?.["ai.nimblebrain/internal"],
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
        const shown = matches.slice(0, 25);
        const suffix = matches.length > shown.length ? ` (showing top ${shown.length})` : "";
        const lines = [`Found ${matches.length} tool(s) for "${query}"${suffix}:\n`];
        for (const t of shown) lines.push(`- **${t.name}**: ${t.description}`);
        return {
          content: textContent(lines.join("\n")),
          structuredContent: { tools: shown.map((t) => ({ name: t.name })) },
          isError: false,
        };
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

  // Connectors tool. Single surface for both workspace-targeted and
  // personal-workspace-targeted connectors — the install destination
  // is chosen by the catalog entry's `defaultBinding`, and disconnects
  // look up the binding workspace from the installed ref.
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
          const wsId = runtime?.requireWorkspaceId();
          if (!runtime || !wsId) {
            return { content: textContent("Skill status not available."), isError: false };
          }
          return await handleSkillStatus(runtime, getSkills, lifecycle, nameQuery, wsId);
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

async function handleSkillStatus(
  runtime: Runtime,
  getSkills: GetSkillsFn | undefined,
  lifecycle: BundleLifecycleManager | undefined,
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
    return { content: textContent(formatSkillDetail(skill, lifecycle, wsId)), isError: false };
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
  const layer3Visible = layer3.filter((s) => !coreNames.has(s.skill.manifest.name));
  const alwaysLoaded = layer3Visible.filter((s) => s.loadedBy === "always");
  const toolAffined = layer3Visible.filter((s) => s.loadedBy === "tool_affinity");
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
  if (alwaysLoaded.length > 0) {
    const lines = ["## Workspace & User Skills (always loaded)"];
    for (const s of alwaysLoaded) lines.push(formatLayer3Summary(s));
    sections.push(lines.join("\n"));
  }
  if (toolAffined.length > 0) {
    const lines = ["## Tool-Affined Skills (active)"];
    for (const s of toolAffined) lines.push(formatLayer3Summary(s));
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

/** Summary line for a per-request Layer-3 skill, including why it loaded. */
function formatLayer3Summary(selected: SelectedSkill): string {
  const m = selected.skill.manifest;
  const scope = m.scope ?? "org";
  return `- ${m.name} (${scope}, priority ${m.priority}) — ${m.description || "(no description)"}\n  Loaded: ${selected.reason}`;
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
