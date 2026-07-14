import { readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { artifactResolutionsTotal, recordLlmUsage } from "../api/metrics.ts";
import { textContent } from "../engine/content-helpers.ts";
import { INTERNAL_TOOL_ANNOTATION, type ToolResult } from "../engine/types.ts";
import {
  type ArtifactListItem,
  type ArtifactListOptions,
  ArtifactNotFoundError,
  ArtifactTooLargeError,
  getArtifactResolver,
  InvalidArtifactUriError,
} from "../host-resources/artifacts/index.ts";
import { ORG_ADMIN_ROLES } from "../identity/types.ts";
import { getAvailableModels, isModelAllowed } from "../model/catalog.ts";
import { log } from "../observability/log.ts";
import {
  getRequestContext,
  type RequestContext,
  runWithRequestContext,
} from "../runtime/request-context.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { TokenUsage } from "../usage/types.ts";
import { canWriteWorkspaceScoped } from "../workspace/authz.ts";
import type { InProcessTool } from "./in-process-app.ts";

const pkgPath = resolve(import.meta.dirname ?? __dirname, "../../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
  name: string;
  version: string;
  dependencies: Record<string, string>;
};
// Prefer the build-time-injected git tag; fall back to package.json for local dev.
const VERSION = process.env.NB_VERSION || pkg.version;

import { ActivityCollector } from "../services/activity-collector.ts";
import { BriefingCache } from "../services/briefing-cache.ts";
import { collectBriefingFacets } from "../services/briefing-collector.ts";
import { BriefingGenerator } from "../services/briefing-generator.ts";
import { renderBriefingText } from "../services/briefing-render.ts";
import type { BriefingOutput } from "../services/home-types.ts";

// --- set_model_config helpers -------------------------------------------------
// The handler is a linear validate → normalize → merge → write pipeline; each
// stage is factored out so no single function carries the whole decision tree.
// Validators return an error message (surfaced as an `isError` tool result) or
// null when the field is absent or valid.

const MODEL_SLOTS = ["default", "fast", "reasoning"];

/** Org-admin gate. Dev mode (no identity provider) bypasses. */
function checkModelConfigAccess(runtime: Runtime): string | null {
  if (runtime.getIdentityProvider() === null) return null;
  const identity = runtime.getCurrentIdentity();
  if (!identity) {
    return (
      "set_model_config requires an authenticated identity. " +
      "Calls without a request context (e.g. background jobs) cannot configure platform-wide model settings."
    );
  }
  if (!ORG_ADMIN_ROLES.has(identity.orgRole)) {
    return "Only org admins or owners can change model configuration. The model config affects every workspace.";
  }
  return null;
}

/**
 * Normalize the `clear*` boolean sentinels into the canonical `null` the merge
 * logic understands. Mutates `input` in place (each tool call owns its input).
 * Returns an error message if mutually-exclusive fields were combined.
 */
function normalizeModelConfigClears(input: Record<string, unknown>): string | null {
  if (input.clearThinking === true) {
    if (input.thinking !== undefined && input.thinking !== null) {
      return "Cannot set both `thinking` and `clearThinking`. Use one or the other.";
    }
    if (input.thinkingBudgetTokens !== undefined && input.thinkingBudgetTokens !== null) {
      return (
        "Cannot set `thinkingBudgetTokens` while clearing `thinking` — " +
        "clearing the mode also clears the budget. Drop one or the other."
      );
    }
    input.thinking = null;
  }
  if (input.clearThinkingBudget === true) {
    if (input.thinkingBudgetTokens !== undefined && input.thinkingBudgetTokens !== null) {
      return "Cannot set both `thinkingBudgetTokens` and `clearThinkingBudget`. Use one or the other.";
    }
    input.thinkingBudgetTokens = null;
  }
  return null;
}

/** Validate a positive-integer field. `max` omitted ⇒ "positive integer" wording. */
function positiveIntFieldError(
  value: unknown,
  label: string,
  min: number,
  max?: number,
): string | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    return max !== undefined
      ? `${label} must be an integer between ${min} and ${max}.`
      : `${label} must be a positive integer.`;
  }
  return null;
}

function validateModelSlots(input: Record<string, unknown>, runtime: Runtime): string | null {
  if (input.models !== undefined && typeof input.models === "object") {
    for (const [slot, value] of Object.entries(input.models as Record<string, unknown>)) {
      if (!MODEL_SLOTS.includes(slot)) {
        return `Unknown model slot "${slot}". Valid slots: default, fast, reasoning.`;
      }
      if (!isModelAllowed(String(value), runtime.getProviderConfigs())) {
        return `Invalid model "${String(value)}" for slot "${slot}". Either the provider is not configured or the model is not in the allowlist. Configured providers: ${runtime.getConfiguredProviders().join(", ")}`;
      }
    }
  }
  if (input.defaultModel !== undefined) {
    const model = String(input.defaultModel);
    if (!isModelAllowed(model, runtime.getProviderConfigs())) {
      return `Invalid model "${model}". Either the provider is not configured or the model is not in the allowlist. Configured providers: ${runtime.getConfiguredProviders().join(", ")}`;
    }
  }
  return null;
}

function validateModelConfigLimits(input: Record<string, unknown>): string | null {
  return (
    positiveIntFieldError(input.maxIterations, "maxIterations", 1, 50) ??
    positiveIntFieldError(input.maxInputTokens, "maxInputTokens", 1) ??
    positiveIntFieldError(input.maxOutputTokens, "maxOutputTokens", 1)
  );
}

/**
 * Cross-field rule: thinking="enabled" needs a budget, from this patch or the
 * effective (seed+override) config — otherwise the Anthropic SDK silently
 * downgrades to its 1,024-token minimum. A patch that clears the budget forces
 * the effective read to null so the check mirrors the post-merge state.
 */
function validateThinkingEnabledBudget(
  input: Record<string, unknown>,
  runtime: Runtime,
): string | null {
  if (input.thinking !== "enabled") return null;
  const clearingBudget = input.thinkingBudgetTokens === null;
  const patchBudget =
    !clearingBudget && input.thinkingBudgetTokens !== undefined
      ? Number(input.thinkingBudgetTokens)
      : undefined;
  const effectiveBudget = clearingBudget
    ? undefined
    : runtime.getRuntimeConfig().thinkingBudgetTokens;
  if (patchBudget == null && effectiveBudget == null) {
    return (
      'thinking="enabled" requires thinkingBudgetTokens (≥ 1024). ' +
      "Provide a budget alongside enabled, or use adaptive instead."
    );
  }
  return null;
}

function validateModelConfigThinking(
  input: Record<string, unknown>,
  runtime: Runtime,
): string | null {
  if (input.thinking !== undefined && input.thinking !== null) {
    const v = String(input.thinking);
    if (v !== "off" && v !== "adaptive" && v !== "enabled") {
      return 'thinking must be "off", "adaptive", "enabled", or null (clear override).';
    }
  }
  if (input.thinkingBudgetTokens !== undefined && input.thinkingBudgetTokens !== null) {
    const n = Number(input.thinkingBudgetTokens);
    if (!Number.isInteger(n) || n < 1024) {
      return "thinkingBudgetTokens must be a positive integer ≥ 1024 (Anthropic minimum).";
    }
  }
  return validateThinkingEnabledBudget(input, runtime);
}

/** All of set_model_config's input validation, in order. */
function validateModelConfigPatch(input: Record<string, unknown>, runtime: Runtime): string | null {
  return (
    validateModelSlots(input, runtime) ??
    validateModelConfigLimits(input) ??
    validateModelConfigThinking(input, runtime)
  );
}

/** Merge the validated patch into the on-disk override object (mutates `existing`). */
function mergeModelConfigOverride(
  existing: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  if (input.models !== undefined && typeof input.models === "object") {
    if (!existing.models || typeof existing.models !== "object") existing.models = {};
    const existingModels = existing.models as Record<string, unknown>;
    for (const [slot, value] of Object.entries(input.models as Record<string, unknown>)) {
      existingModels[slot] = String(value);
    }
  }
  if (input.defaultModel !== undefined) existing.defaultModel = String(input.defaultModel);
  if (input.maxIterations !== undefined) existing.maxIterations = Number(input.maxIterations);
  if (input.maxInputTokens !== undefined) existing.maxInputTokens = Number(input.maxInputTokens);
  if (input.maxOutputTokens !== undefined) existing.maxOutputTokens = Number(input.maxOutputTokens);
  // null = clear the operator override; undefined = leave alone.
  if (input.thinking === null) {
    delete existing.thinking;
    // Clearing the mode also clears the budget — a budget without a mode is meaningless.
    delete existing.thinkingBudgetTokens;
  } else if (input.thinking !== undefined) {
    existing.thinking = String(input.thinking);
  }
  if (input.thinkingBudgetTokens === null) {
    delete existing.thinkingBudgetTokens;
  } else if (input.thinkingBudgetTokens !== undefined) {
    existing.thinkingBudgetTokens = Number(input.thinkingBudgetTokens);
  }
}

/** Build the live-runtime `updateConfig` patch from the validated input. */
function buildModelConfigRuntimePatch(input: Record<string, unknown>): Record<string, unknown> {
  const modelsPatch =
    input.models !== undefined && typeof input.models === "object"
      ? Object.fromEntries(
          Object.entries(input.models as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        )
      : undefined;
  const thinkingPatch =
    input.thinking === undefined
      ? {}
      : input.thinking === null
        ? { thinking: null, thinkingBudgetTokens: null }
        : { thinking: String(input.thinking) as "off" | "adaptive" | "enabled" };
  const budgetPatch =
    input.thinkingBudgetTokens === undefined || input.thinking === null
      ? {}
      : input.thinkingBudgetTokens === null
        ? { thinkingBudgetTokens: null }
        : { thinkingBudgetTokens: Number(input.thinkingBudgetTokens) };
  return {
    ...(modelsPatch ? { models: modelsPatch } : {}),
    ...(input.defaultModel !== undefined ? { defaultModel: String(input.defaultModel) } : {}),
    ...(input.maxIterations !== undefined ? { maxIterations: Number(input.maxIterations) } : {}),
    ...(input.maxInputTokens !== undefined ? { maxInputTokens: Number(input.maxInputTokens) } : {}),
    ...(input.maxOutputTokens !== undefined
      ? { maxOutputTokens: Number(input.maxOutputTokens) }
      : {}),
    ...thinkingPatch,
    ...budgetPatch,
  };
}

// --- set_preferences helpers --------------------------------------------------

const PREFERENCE_FIELDS = ["displayName", "timezone", "locale", "theme"];

/** Coerce the allowed preference inputs into a string patch, skipping unset fields. */
function buildPreferencesPatch(input: Record<string, unknown>): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (PREFERENCE_FIELDS.includes(key) && value !== undefined) {
      patch[key] = String(value);
    }
  }
  return patch;
}

// --- list_artifacts / read_artifact helpers -----------------------------------

type ArtifactReadResult = Awaited<ReturnType<ReturnType<typeof getArtifactResolver>["read"]>>;

/** Pull the validated list filters (type/cursor/limit) from raw tool input. */
function buildArtifactListOptions(input: Record<string, unknown>): ArtifactListOptions {
  const opts: ArtifactListOptions = {};
  if (typeof input.type === "string" && input.type.trim()) opts.type = input.type.trim();
  if (typeof input.cursor === "string" && input.cursor.trim()) opts.cursor = input.cursor.trim();
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) opts.limit = input.limit;
  return opts;
}

/** Render the human-readable artifact list, with a pagination hint when more remain. */
function renderArtifactListText(items: ArtifactListItem[], nextCursor: string | undefined): string {
  const lines = items.map(
    (a) => `- ${a.title ?? a.artifactId} — ${a.type} (${a.createdAt}) → ${a.uri}`,
  );
  return items.length
    ? `${items.length} artifact(s):\n${lines.join("\n")}${
        nextCursor ? "\n\n(more available — pass cursor to continue)" : ""
      }`
    : "No artifacts found in this workspace.";
}

/** Coerce raw tool input into a canonical artifact:// URI, or null when absent. */
function normalizeArtifactUri(input: Record<string, unknown>): string | null {
  const raw = typeof input.uri === "string" ? input.uri.trim() : "";
  if (!raw) return null;
  return raw.startsWith("artifact://") ? raw : `artifact://${raw}`;
}

/** Flatten resolved artifact contents into text, tagging binary parts. */
function renderArtifactContentText(contents: ArtifactReadResult["contents"]): string {
  return contents
    .map((c) =>
      "text" in c && typeof c.text === "string"
        ? c.text
        : "blob" in c
          ? `[binary artifact, mimeType=${c.mimeType ?? "unknown"}]`
          : "",
    )
    .join("");
}

/**
 * Map a read failure to its metric label + tool error result. Same label
 * granularity as the UI read path (handlers.ts) so
 * `nb_artifact_resolutions_total{result}` means one thing across both resolution
 * sites: a malformed id (client/model input) and an over-cap body are not server
 * errors and must not inflate `error`.
 */
function artifactReadErrorResult(err: unknown, uri: string): ToolResult {
  if (err instanceof InvalidArtifactUriError) {
    artifactResolutionsTotal.inc({ result: "malformed" });
    return { content: textContent(`Malformed artifact URI "${uri}".`), isError: true };
  }
  if (err instanceof ArtifactNotFoundError) {
    artifactResolutionsTotal.inc({ result: "not_found" });
    return {
      content: textContent(
        `Artifact "${uri}" not found in this workspace (it may not exist, or belong to another workspace).`,
      ),
      isError: true,
    };
  }
  if (err instanceof ArtifactTooLargeError) {
    artifactResolutionsTotal.inc({ result: "too_large" });
    return { content: textContent(err.message), isError: true };
  }
  artifactResolutionsTotal.inc({ result: "error" });
  return {
    content: textContent(
      `Failed to read artifact: ${err instanceof Error ? err.message : String(err)}`,
    ),
    isError: true,
  };
}

// --- briefing helpers ---------------------------------------------------------

/** The authenticated caller resolved by the runtime for the current request. */
type CurrentIdentity = NonNullable<ReturnType<Runtime["getCurrentIdentity"]>>;
/** The workspace's home/briefing config (user name, timezone, cache TTL). */
type HomeConfig = ReturnType<Runtime["getHomeConfig"]>;

/**
 * Build the briefing tool result. `content` carries the rendered briefing (the
 * only field the model sees — the engine never feeds `structuredContent` to the
 * prompt), prefixed with the status note. `structuredContent` keeps the typed
 * payload for the dashboard.
 */
function briefingOk(briefing: BriefingOutput, note: string): ToolResult {
  return {
    content: textContent(`${note}\n\n${renderBriefingText(briefing)}`),
    structuredContent: briefing as unknown as Record<string, unknown>,
    isError: false,
  };
}

/** Get or create the per-workspace briefing cache. */
function getBriefingCache(
  caches: Map<string, BriefingCache>,
  wsId: string,
  cacheTtlMinutes: number,
): BriefingCache {
  let cache = caches.get(wsId);
  if (!cache) {
    cache = new BriefingCache(cacheTtlMinutes);
    caches.set(wsId, cache);
  }
  return cache;
}

/**
 * Persist a briefing generation's token usage. The fast-slot generation emits no
 * llm.response, so usage lands as an aux.usage event. The metric fires for every
 * generation (including the background refresh, which has no conversation to
 * attribute to — Prometheus captures the cost the aux.usage event can't); the
 * event only appends when a foreground conversation is in context.
 */
function recordBriefingUsage(
  runtime: Runtime,
  wsId: string,
  identity: CurrentIdentity,
  modelString: string,
  usage: TokenUsage,
  llmMs: number,
): void {
  recordLlmUsage("briefing", modelString ?? "unknown", usage);
  const convId = getRequestContext()?.conversationId;
  if (!convId) return;
  // The foreground briefing runs inside the caller's conversation, whose
  // workspace is this focused workspace + owner — so append by path directly
  // (O(1)), never a cross-workspace `locate` walk. Guard the append so a missed
  // aux.usage event can never break briefing generation.
  try {
    runtime.workspaceConversationStore(wsId, identity.id).appendEvent(convId, {
      ts: new Date().toISOString(),
      type: "aux.usage",
      source: "briefing",
      model: modelString ?? "unknown",
      usage,
      llmMs,
    });
  } catch {
    // best-effort: usage attribution, not correctness
  }
}

/**
 * Collect activity + facets, then run the fast model (the slow part). Reads
 * request-scoped state (workspace, identity, model slot), so it must run inside a
 * request context — the foreground request's, or the re-established one for the
 * background refresh.
 */
async function generateBriefing(
  runtime: Runtime,
  wsId: string,
  identity: CurrentIdentity,
  homeConfig: HomeConfig,
): Promise<BriefingOutput> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();
  const collector = new ActivityCollector({
    logDir: join(runtime.getWorkspaceScopedDir(wsId), "logs"),
    conversations: {
      kind: "store",
      store: { list: (o, a) => runtime.listConversations(o, a) },
    },
    access: { userId: identity.id },
  });
  const activity = await collector.collect({ since });
  const registry = runtime.getRegistryForCurrentWorkspace();
  const instances = runtime.getBundleInstancesForWorkspace(wsId);
  const facetContext = await collectBriefingFacets(instances, registry, { since, until });
  const modelString = runtime.getModelSlot("fast");
  const generator = new BriefingGenerator(
    runtime.resolveModel(modelString),
    modelString,
    {
      userName: homeConfig.userName,
      timezone: homeConfig.timezone,
      cacheTtlMinutes: homeConfig.cacheTtlMinutes,
    },
    (usage, llmMs) => recordBriefingUsage(runtime, wsId, identity, modelString, usage, llmMs),
  );
  return generator.generate(activity, facetContext);
}

/**
 * Serve a briefing from cache when one is available: fresh → instant; stale →
 * serve-stale while scheduling a background refresh. Returns null when nothing is
 * cached and the caller must generate synchronously.
 */
function serveCachedBriefing(
  runtime: Runtime,
  briefingCache: BriefingCache,
  wsId: string,
  identity: CurrentIdentity,
  homeConfig: HomeConfig,
): ToolResult | null {
  // Fresh cache → instant.
  const fresh = briefingCache.get();
  if (fresh) return briefingOk(fresh, "Briefing retrieved from cache.");

  // Stale-while-revalidate: serve the last (expired) briefing immediately and
  // regenerate in the BACKGROUND, so the dashboard never waits on the LLM after
  // the first generation.
  const stale = briefingCache.getStale();
  if (!stale) return null;
  scheduleBriefingRefresh(runtime, briefingCache, wsId, identity, homeConfig);
  return briefingOk(stale, "Briefing (refreshing in background).");
}

/**
 * Stale-while-revalidate: kick off a single background regeneration, guarded so a
 * burst of dashboard loads during the regen window can't fan out into N
 * concurrent fast-model calls (thundering herd on a hot path). The bg task
 * re-establishes the workspace request context — `collectBriefingFacets`
 * dispatches facet tools via `registry.execute`, which read `requireWorkspaceId()`
 * / identity from that context.
 */
function scheduleBriefingRefresh(
  runtime: Runtime,
  briefingCache: BriefingCache,
  wsId: string,
  identity: CurrentIdentity,
  homeConfig: HomeConfig,
): void {
  if (!briefingCache.beginRefresh()) return;
  const bgCtx: RequestContext = {
    identity,
    scope: {
      kind: "workspace",
      workspaceId: wsId,
      workspaceAgents: null,
      workspaceModelOverride: null,
    },
  };
  void runWithRequestContext(bgCtx, () => generateBriefing(runtime, wsId, identity, homeConfig))
    .then((b) => briefingCache.set(b))
    .catch((err) =>
      log.warn(
        `[briefing] background refresh failed for ${wsId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    )
    .finally(() => briefingCache.endRefresh());
}

/**
 * Factory that creates core platform management tool definitions.
 * Each tool is a thin wrapper delegating to Runtime methods.
 * Returns raw InProcessTool[] — caller (the `nb` system source factory)
 * passes them to `defineInProcessApp` to build the in-process MCP server.
 */
export function createCoreToolDefs(runtime: Runtime): InProcessTool[] {
  // Per-workspace briefing caches keyed by workspace ID (or "_global" for dev mode).
  const briefingCaches = new Map<string, BriefingCache>();

  const toolDefs: InProcessTool[] = [
    {
      name: "list_apps",
      description: "List installed apps/bundles with status, tool count, and trust scores.",
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (): Promise<ToolResult> => {
        try {
          const apps = await runtime.getApps();
          return {
            content: textContent(`${apps.length} app(s) installed.`),
            structuredContent: { apps },
            isError: false,
          };
        } catch (err) {
          return {
            content: textContent(
              `Failed to list apps: ${err instanceof Error ? err.message : String(err)}`,
            ),
            isError: true,
          };
        }
      },
    },
    {
      name: "get_config",
      description:
        "Get current runtime configuration: default model, configured providers, and limits.",
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (): Promise<ToolResult> => {
        try {
          const models = runtime.getModelSlots();
          const defaultModel = runtime.getDefaultModel();
          const configuredProviders = runtime.getConfiguredProviders();
          const availableModels = getAvailableModels(runtime.getProviderConfigs());
          const maxIterations = runtime.getMaxIterations();
          const maxInputTokens = runtime.getMaxInputTokens();
          const maxOutputTokens = runtime.getMaxOutputTokens();
          const runtimeConfig = runtime.getRuntimeConfig();
          const identity = runtime.getCurrentIdentity();
          const preferences = identity?.preferences ?? {};
          return {
            content: textContent("Current runtime configuration."),
            structuredContent: {
              models,
              defaultModel,
              configuredProviders,
              availableModels,
              maxIterations,
              maxInputTokens,
              maxOutputTokens,
              ...(runtimeConfig.thinking !== undefined ? { thinking: runtimeConfig.thinking } : {}),
              ...(runtimeConfig.thinkingBudgetTokens !== undefined
                ? { thinkingBudgetTokens: runtimeConfig.thinkingBudgetTokens }
                : {}),
              preferences: {
                displayName: identity?.displayName ?? "",
                timezone: preferences.timezone ?? "",
                locale: preferences.locale ?? "en-US",
                theme: preferences.theme ?? "system",
              },
            },
            isError: false,
          };
        } catch (err) {
          return {
            content: textContent(
              `Failed to get config: ${err instanceof Error ? err.message : String(err)}`,
            ),
            isError: true,
          };
        }
      },
    },
    {
      name: "version",
      description:
        "Get platform version info: agent version and all dependency versions from package.json.",
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (): Promise<ToolResult> => {
        return {
          content: textContent(`${pkg.name} v${VERSION}`),
          structuredContent: {
            name: pkg.name,
            version: VERSION,
            dependencies: pkg.dependencies,
          },
          isError: false,
        };
      },
    },
    {
      // Atomic write (temp + rename) but NOT lock-protected against
      // concurrent calls: two parallel set_model_config invocations both
      // read the override file, both apply their patch to the read state,
      // both write — last writer wins, first writer's patch is silently
      // lost. Admin-only and rare in practice; documenting here so the
      // next caller doesn't assume it's safe to fire many in parallel.
      // If concurrency becomes a real concern, gate writes on a per-path
      // mutex via async-mutex or similar.
      name: "set_model_config",
      description:
        "Update model selection and runtime limits. Writes atomically to nimblebrain.overrides.json (preserved across deploys). Does not allow changing API keys or secrets.",
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: {
        type: "object",
        properties: {
          models: {
            type: "object",
            description: "Role-based model slots. Each slot maps to a provider:model-id string.",
            properties: {
              default: { type: "string", description: "Primary model for chat." },
              fast: { type: "string", description: "Cheap/fast model for auxiliary tasks." },
              reasoning: {
                type: "string",
                description: "Most capable model for complex analysis.",
              },
            },
          },
          defaultModel: {
            type: "string",
            description: "Default model ID. Deprecated — use models.default instead.",
          },
          maxIterations: {
            type: "number",
            description: "Max agentic iterations per request (1-25).",
          },
          maxInputTokens: {
            type: "number",
            description: "Max input tokens per request (must be > 0).",
          },
          maxOutputTokens: {
            type: "number",
            description: "Max output tokens per LLM call (must be > 0).",
          },
          thinking: {
            type: "string",
            enum: ["off", "adaptive", "enabled"],
            description:
              "Extended-thinking mode for reasoning-capable models. " +
              "off: never reason. adaptive: model decides per call. " +
              "enabled: always reason (use thinkingBudgetTokens to cap). " +
              "Use clearThinking=true to revert to the platform default.",
          },
          clearThinking: {
            type: "boolean",
            description:
              "If true, clears any persisted thinking override and reverts to the platform default. " +
              "Mutually exclusive with `thinking`.",
          },
          thinkingBudgetTokens: {
            type: "number",
            description:
              "Token budget when thinking=enabled. Counts toward maxOutputTokens. " +
              "Anthropic requires a minimum of 1,024.",
          },
          clearThinkingBudget: {
            type: "boolean",
            description:
              "If true, clears any persisted thinking budget. " +
              "Mutually exclusive with `thinkingBudgetTokens`.",
          },
        },
      },
      handler: async (input): Promise<ToolResult> => {
        try {
          // Org-admin gate: `set_model_config` writes platform-wide config, so
          // the tool (not just the UI) is the security boundary — any caller
          // (agent, external MCP client) is role-checked here.
          const accessError = checkModelConfigAccess(runtime);
          if (accessError) return { content: textContent(accessError), isError: true };

          // Writes go to the override file, NOT the Helm-managed seed.
          // The init container overwrites the seed on every deploy, so any
          // value written here would last only until the next rollout. The
          // override file is a sibling on the PVC that the init container
          // leaves alone, so user changes survive deploys. The runtime
          // loader merges seed → override at startup; override values win.
          const configOverridePath = runtime.getConfigOverridePath();
          if (!configOverridePath) {
            return {
              content: textContent("No config override path available. Cannot persist changes."),
              isError: true,
            };
          }

          // Normalize the `clear*` booleans into the canonical `null` sentinel
          // the merge logic understands (booleans keep the schema string-typed,
          // which Gemini requires). Mutates `input`; safe because each tool call
          // owns its input.
          const clearError = normalizeModelConfigClears(input);
          if (clearError) return { content: textContent(clearError), isError: true };

          const validationError = validateModelConfigPatch(input, runtime);
          if (validationError) return { content: textContent(validationError), isError: true };

          // Read current override file (the one we'll patch and write back).
          // The seed file is read separately by the runtime loader; we only
          // touch overrides here.
          let existing: Record<string, unknown> = {};
          try {
            const raw = await readFile(configOverridePath, "utf-8");
            existing = JSON.parse(raw);
          } catch {
            // Override file doesn't exist yet (fresh deploy / first call) —
            // start with empty overrides.
          }

          mergeModelConfigOverride(existing, input);

          // Atomic write of the override file: write to temp file, then rename.
          const tmpPath = `${configOverridePath}.tmp.${Date.now()}`;
          await writeFile(tmpPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
          await rename(tmpPath, configOverridePath);

          // Apply the same patch to the live runtime config.
          runtime.updateConfig(buildModelConfigRuntimePatch(input));

          // Emit config.changed event
          const eventSink = runtime.getEventSink();
          eventSink.emit({
            type: "config.changed",
            data: {
              fields: Object.keys(input).filter((k) => input[k] !== undefined),
            },
          });

          const updatedFields = Object.keys(input).filter((k) => input[k] !== undefined);
          return {
            content: textContent(`Configuration updated: ${updatedFields.join(", ")}.`),
            structuredContent: { success: true, updated: existing },
            isError: false,
          };
        } catch (err) {
          return {
            content: textContent(
              `Failed to update config: ${err instanceof Error ? err.message : String(err)}`,
            ),
            isError: true,
          };
        }
      },
    },
    {
      name: "set_preferences",
      description:
        "Set user preferences: display name, timezone, locale, or theme. Use this when the user says their name, asks to change timezone/language/theme, or says 'call me X'.",
      inputSchema: {
        type: "object",
        properties: {
          displayName: { type: "string", description: "User's display name (e.g., 'Matt')." },
          timezone: { type: "string", description: "IANA timezone (e.g., 'Pacific/Honolulu')." },
          locale: { type: "string", description: "BCP 47 locale (e.g., 'en-US')." },
          theme: { type: "string", enum: ["system", "light", "dark"], description: "Color theme." },
        },
      },
      handler: async (input): Promise<ToolResult> => {
        try {
          const identity = runtime.getCurrentIdentity();
          if (!identity) {
            return { content: textContent("No authenticated user."), isError: true };
          }

          const patch = buildPreferencesPatch(input);
          if (Object.keys(patch).length === 0) {
            return { content: textContent("No valid preference fields provided."), isError: true };
          }

          // Update the user's profile with new preferences
          const userStore = runtime.getUserStore();
          const user = await userStore.get(identity.id);
          if (!user) {
            return { content: textContent("User profile not found."), isError: true };
          }

          const updatedPrefs = { ...user.preferences, ...patch };

          // displayName is a top-level User field, not a preference
          const userPatch: Record<string, unknown> = { preferences: updatedPrefs };
          if (patch.displayName) {
            userPatch.displayName = patch.displayName;
          }
          await userStore.update(identity.id, userPatch);

          // Invalidate cached identity so next request picks up new preferences
          runtime.invalidateUserCache(identity.id);

          // Emit event so the web client can refresh
          runtime.getEventSink().emit({
            type: "config.changed",
            data: { fields: ["preferences"] },
          });

          return {
            content: textContent(`Preferences updated: ${Object.keys(patch).join(", ")}.`),
            structuredContent: { success: true, preferences: updatedPrefs },
            isError: false,
          };
        } catch (err) {
          return {
            content: textContent(
              `Failed to set preferences: ${err instanceof Error ? err.message : String(err)}`,
            ),
            isError: true,
          };
        }
      },
    },
    {
      name: "manage_identity",
      description:
        "Write or reset the workspace agent personality override. Only workspace admins or org admins can modify.",
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: {
        type: "object",
        properties: {
          body: {
            type: "string",
            description: "Markdown content to write as the workspace identity override.",
          },
          action: {
            type: "string",
            enum: ["reset"],
            description: 'Set to "reset" to clear the workspace identity override.',
          },
        },
      },
      handler: async (input): Promise<ToolResult> => {
        try {
          const wsId = runtime.requireWorkspaceId();
          const identity = runtime.getCurrentIdentity();

          // Workspace-scoped write gate (STRICT): only a workspace admin member
          // may modify identity; orgRole grants no bypass.
          // Null identity (dev/unauthenticated mode) is intentionally allowed
          // through here, matching the prior behavior where the gate was wrapped
          // in `if (identity)`.
          if (identity) {
            const ws = await runtime.getWorkspaceStore().get(wsId);
            const decision = canWriteWorkspaceScoped(identity, ws);
            if (!decision.allowed) {
              return {
                content: textContent(decision.reason),
                isError: true,
              };
            }
          }

          if (input.action === "reset") {
            await runtime.getWorkspaceStore().update(wsId, { identity: undefined });
            runtime.getEventSink().emit({
              type: "config.changed",
              data: { fields: ["identity"] },
            });
            return {
              content: textContent("Workspace identity override cleared."),
              structuredContent: { action: "reset", success: true },
              isError: false,
            };
          }

          if (typeof input.body === "string") {
            await runtime.getWorkspaceStore().update(wsId, { identity: input.body });
            runtime.getEventSink().emit({
              type: "config.changed",
              data: { fields: ["identity"] },
            });
            return {
              content: textContent("Workspace identity override saved."),
              structuredContent: { action: "write", success: true },
              isError: false,
            };
          }

          return {
            content: textContent("Either 'body' (string) or 'action: \"reset\"' is required."),
            isError: true,
          };
        } catch (err) {
          return {
            content: textContent(
              `Failed to manage identity: ${err instanceof Error ? err.message : String(err)}`,
            ),
            isError: true,
          };
        }
      },
    },
    {
      name: "workspace_info",
      description:
        "Get workspace metadata: platform version, telemetry status, and install ID. Used by the web client on startup.",
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (): Promise<ToolResult> => {
        const tm = runtime.getTelemetryManager();
        return {
          content: textContent(
            `Workspace v${VERSION}, telemetry ${tm.isEnabled() ? "enabled" : "disabled"}.`,
          ),
          structuredContent: {
            version: VERSION,
            telemetryEnabled: tm.isEnabled(),
            installId: tm.getAnonymousId(),
          },
          isError: false,
        };
      },
    },
    {
      name: "list_artifacts",
      description:
        "List stored artifacts in this workspace (anything a capability has saved to the artifact store), newest first. Optionally filter by `type`. Returns each artifact's id, title, type, and created_at; read one's content with read_artifact. Workspace-scoped — only this workspace's artifacts are returned.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Filter by artifact type (the producing capability's semantic type).",
          },
          cursor: {
            type: "string",
            description: "Pagination cursor from a prior call's next_cursor.",
          },
          limit: { type: "number", description: "Max rows to return (data-plane-capped)." },
        },
      },
      handler: async (input): Promise<ToolResult> => {
        try {
          const wsId = runtime.requireWorkspaceId();
          const { items, nextCursor } = await getArtifactResolver().list(
            wsId,
            buildArtifactListOptions(input),
          );
          return {
            content: textContent(renderArtifactListText(items, nextCursor)),
            structuredContent: { artifacts: items, ...(nextCursor ? { nextCursor } : {}) },
            isError: false,
          };
        } catch (err) {
          return {
            content: textContent(
              `Failed to list artifacts: ${err instanceof Error ? err.message : String(err)}`,
            ),
            isError: true,
          };
        }
      },
    },
    {
      name: "read_artifact",
      description:
        "Read a stored artifact's content by its `artifact://` URI (or bare id), scoped to this workspace. Use this to retrieve an artifact referenced in this or a past conversation (a tool result's resource link), or an id from list_artifacts. Returns the artifact text.",
      inputSchema: {
        type: "object",
        properties: {
          uri: {
            type: "string",
            description: "The artifact URI (artifact://art_...) or bare artifact id.",
          },
        },
        required: ["uri"],
      },
      handler: async (input): Promise<ToolResult> => {
        const uri = normalizeArtifactUri(input);
        if (!uri) {
          return { content: textContent("uri is required"), isError: true };
        }
        try {
          const wsId = runtime.requireWorkspaceId();
          const result = await getArtifactResolver().read(uri, wsId);
          const text = renderArtifactContentText(result.contents);
          artifactResolutionsTotal.inc({ result: "ok" });
          return { content: textContent(text || "[empty artifact]"), isError: false };
        } catch (err) {
          return artifactReadErrorResult(err, uri);
        }
      },
    },
    // --- Briefing tool (in-process, uses runtime model resolver) ---
    {
      name: "briefing",
      description:
        "Generate a personalized activity briefing for the workspace using the fast model slot. Returns a summary of recent activity, upcoming items, and anything needing attention. May take a few seconds.",
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: {
        type: "object",
        properties: {
          force_refresh: {
            type: "boolean",
            description: "Bypass cache and regenerate. Default: false.",
          },
        },
      },
      handler: async (input): Promise<ToolResult> => {
        try {
          const homeConfig = runtime.getHomeConfig();
          const wsId = runtime.requireWorkspaceId();

          // Conversations live at the user level (post-Stage 1); the activity
          // collector reads the top-level store with an ownership filter so
          // the briefing stays scoped to the caller, not the whole deployment.
          const identity = runtime.getCurrentIdentity();
          if (!identity) {
            return {
              content: textContent("Briefing requires an authenticated identity."),
              isError: true,
            };
          }

          const briefingCache = getBriefingCache(briefingCaches, wsId, homeConfig.cacheTtlMinutes);

          // Skip the cache entirely on force_refresh; otherwise serve a fresh or
          // stale-while-revalidating result if one is cached.
          const cached = input.force_refresh
            ? null
            : serveCachedBriefing(runtime, briefingCache, wsId, identity, homeConfig);
          if (cached) return cached;

          // No cached briefing yet (first generation), or an explicit
          // force_refresh: generate synchronously. generate() throws on LLM
          // failure → the outer catch turns it into an isError result, which
          // the home UI renders as a retry state.
          const briefing = await generateBriefing(runtime, wsId, identity, homeConfig);
          briefingCache.set(briefing);
          return briefingOk(briefing, "Briefing generated.");
        } catch (err) {
          return {
            content: textContent(
              `Failed to generate briefing: ${err instanceof Error ? err.message : String(err)}`,
            ),
            isError: true,
          };
        }
      },
    },
  ];

  return toolDefs;
}
