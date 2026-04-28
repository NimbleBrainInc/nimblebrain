import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import { ORG_ADMIN_ROLES } from "../identity/types.ts";
import { getAvailableModels, isModelAllowed } from "../model/catalog.ts";
import type { Runtime } from "../runtime/runtime.ts";
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
import type { BriefingOutput } from "../services/home-types.ts";

/**
 * Factory that creates core platform management tool definitions.
 * Each tool is a thin wrapper delegating to Runtime methods.
 * Returns raw InProcessTool[] — caller (the `nb` system source factory)
 * passes them to `defineInProcessApp` to build the in-process MCP server.
 */
export function createCoreToolDefs(runtime: Runtime): InProcessTool[] {
  const toolDefs: InProcessTool[] = [
    {
      name: "list_apps",
      description: "List installed apps/bundles with status, tool count, and trust scores.",
      annotations: { "ai.nimblebrain/internal": true },
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
      annotations: { "ai.nimblebrain/internal": true },
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
      annotations: { "ai.nimblebrain/internal": true },
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
      name: "set_model_config",
      description:
        "Update model selection and runtime limits. Writes atomically to nimblebrain.json. Does not allow changing API keys or secrets.",
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
            type: ["string", "null"],
            enum: ["off", "adaptive", "enabled", null],
            description:
              "Extended-thinking mode for reasoning-capable models. " +
              "off: never reason. adaptive: model decides per call. " +
              "enabled: always reason (use thinkingBudgetTokens to cap). " +
              "null: clear the operator override and revert to platform default " +
              "(adaptive for catalog-flagged reasoning models, off otherwise).",
          },
          thinkingBudgetTokens: {
            type: "number",
            description:
              "Token budget when thinking=enabled. Counts toward maxOutputTokens. " +
              "Anthropic requires a minimum of 1,024.",
          },
        },
      },
      handler: async (input): Promise<ToolResult> => {
        try {
          // Org-admin gate: `set_model_config` writes to the platform-wide
          // `nimblebrain.json` (instance-level config). The settings UI hides
          // this tool behind an org_admin RouteGuard, but the backend is the
          // security boundary — the tool itself enforces the role so any
          // caller (agent, external MCP client) can't bypass the UI gate.
          // Dev mode (no identity provider) bypasses, matching the rest of
          // the platform's dev-mode convention.
          //
          // The two failure modes are distinguished so future debug logs
          // make non-user code paths (cron, automations triggered without
          // a request context) obvious — they fail with "no identity"
          // rather than the misleading "wrong role" message.
          if (runtime.getIdentityProvider() !== null) {
            const identity = runtime.getCurrentIdentity();
            if (!identity) {
              return {
                content: textContent(
                  "set_model_config requires an authenticated identity. " +
                    "Calls without a request context (e.g. background jobs) cannot configure platform-wide model settings.",
                ),
                isError: true,
              };
            }
            if (!ORG_ADMIN_ROLES.has(identity.orgRole)) {
              return {
                content: textContent(
                  "Only org admins or owners can change model configuration. The model config affects every workspace.",
                ),
                isError: true,
              };
            }
          }

          const configPath = runtime.getConfigPath();
          if (!configPath) {
            return {
              content: textContent("No config file path available. Cannot persist changes."),
              isError: true,
            };
          }

          // Validate inputs
          if (input.models !== undefined && typeof input.models === "object") {
            const modelsObj = input.models as Record<string, unknown>;
            for (const [slot, value] of Object.entries(modelsObj)) {
              if (!["default", "fast", "reasoning"].includes(slot)) {
                return {
                  content: textContent(
                    `Unknown model slot "${slot}". Valid slots: default, fast, reasoning.`,
                  ),
                  isError: true,
                };
              }
              const model = String(value);
              if (!isModelAllowed(model, runtime.getProviderConfigs())) {
                const providers = runtime.getConfiguredProviders();
                return {
                  content: textContent(
                    `Invalid model "${model}" for slot "${slot}". Either the provider is not configured or the model is not in the allowlist. Configured providers: ${providers.join(", ")}`,
                  ),
                  isError: true,
                };
              }
            }
          }
          if (input.defaultModel !== undefined) {
            const model = String(input.defaultModel);
            if (!isModelAllowed(model, runtime.getProviderConfigs())) {
              const providers = runtime.getConfiguredProviders();
              return {
                content: textContent(
                  `Invalid model "${model}". Either the provider is not configured or the model is not in the allowlist. Configured providers: ${providers.join(", ")}`,
                ),
                isError: true,
              };
            }
          }
          if (input.maxIterations !== undefined) {
            const n = Number(input.maxIterations);
            if (!Number.isInteger(n) || n < 1 || n > 50) {
              return {
                content: textContent("maxIterations must be an integer between 1 and 50."),
                isError: true,
              };
            }
          }
          if (input.maxInputTokens !== undefined) {
            const n = Number(input.maxInputTokens);
            if (!Number.isInteger(n) || n < 1) {
              return {
                content: textContent("maxInputTokens must be a positive integer."),
                isError: true,
              };
            }
          }
          if (input.maxOutputTokens !== undefined) {
            const n = Number(input.maxOutputTokens);
            if (!Number.isInteger(n) || n < 1) {
              return {
                content: textContent("maxOutputTokens must be a positive integer."),
                isError: true,
              };
            }
          }
          // `null` is the explicit "clear my override" sentinel — distinct
          // from `undefined` (skip this field). Validate string values
          // against the enum; pass through nulls unchanged.
          if (input.thinking !== undefined && input.thinking !== null) {
            const v = String(input.thinking);
            if (v !== "off" && v !== "adaptive" && v !== "enabled") {
              return {
                content: textContent(
                  'thinking must be "off", "adaptive", "enabled", or null (clear override).',
                ),
                isError: true,
              };
            }
          }
          if (input.thinkingBudgetTokens !== undefined && input.thinkingBudgetTokens !== null) {
            const n = Number(input.thinkingBudgetTokens);
            if (!Number.isInteger(n) || n < 1024) {
              return {
                content: textContent(
                  "thinkingBudgetTokens must be a positive integer ≥ 1024 (Anthropic minimum).",
                ),
                isError: true,
              };
            }
          }

          // Read current config
          let existing: Record<string, unknown> = {};
          try {
            const raw = await readFile(configPath, "utf-8");
            existing = JSON.parse(raw);
          } catch {
            // File doesn't exist or invalid — start fresh
          }

          // Cross-field validation: thinking="enabled" requires a budget,
          // either from this patch or already in the persisted config.
          // Without one, the Anthropic SDK silently downgrades to its
          // 1,024-token minimum — almost certainly not the operator's
          // intent. Force the explicit choice.
          if (input.thinking === "enabled") {
            const patchBudget =
              input.thinkingBudgetTokens !== undefined && input.thinkingBudgetTokens !== null
                ? Number(input.thinkingBudgetTokens)
                : undefined;
            const existingBudget = existing.thinkingBudgetTokens as number | undefined;
            if (patchBudget == null && existingBudget == null) {
              return {
                content: textContent(
                  'thinking="enabled" requires thinkingBudgetTokens (≥ 1024). ' +
                    "Provide a budget alongside enabled, or use adaptive instead.",
                ),
                isError: true,
              };
            }
          }

          // Merge only allowed fields
          if (input.models !== undefined && typeof input.models === "object") {
            const modelsObj = input.models as Record<string, unknown>;
            if (!existing.models || typeof existing.models !== "object") {
              existing.models = {};
            }
            const existingModels = existing.models as Record<string, unknown>;
            for (const [slot, value] of Object.entries(modelsObj)) {
              existingModels[slot] = String(value);
            }
          }
          if (input.defaultModel !== undefined) existing.defaultModel = String(input.defaultModel);
          if (input.maxIterations !== undefined)
            existing.maxIterations = Number(input.maxIterations);
          if (input.maxInputTokens !== undefined)
            existing.maxInputTokens = Number(input.maxInputTokens);
          if (input.maxOutputTokens !== undefined)
            existing.maxOutputTokens = Number(input.maxOutputTokens);
          // null = clear the operator override; undefined = leave alone.
          if (input.thinking === null) {
            delete existing.thinking;
            // Clearing the mode also clears the budget — a budget without
            // a mode is meaningless and would otherwise hang around.
            delete existing.thinkingBudgetTokens;
          } else if (input.thinking !== undefined) {
            existing.thinking = String(input.thinking);
          }
          if (input.thinkingBudgetTokens === null) {
            delete existing.thinkingBudgetTokens;
          } else if (input.thinkingBudgetTokens !== undefined) {
            existing.thinkingBudgetTokens = Number(input.thinkingBudgetTokens);
          }
          // Atomic write: write to temp file, then rename
          const tmpPath = `${configPath}.tmp.${Date.now()}`;
          await writeFile(tmpPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
          await rename(tmpPath, configPath);

          // Apply changes to live runtime config
          const modelsPatch =
            input.models !== undefined && typeof input.models === "object"
              ? Object.fromEntries(
                  Object.entries(input.models as Record<string, unknown>).map(([k, v]) => [
                    k,
                    String(v),
                  ]),
                )
              : undefined;
          runtime.updateConfig({
            ...(modelsPatch ? { models: modelsPatch } : {}),
            ...(input.defaultModel !== undefined
              ? { defaultModel: String(input.defaultModel) }
              : {}),
            ...(input.maxIterations !== undefined
              ? { maxIterations: Number(input.maxIterations) }
              : {}),
            ...(input.maxInputTokens !== undefined
              ? { maxInputTokens: Number(input.maxInputTokens) }
              : {}),
            ...(input.maxOutputTokens !== undefined
              ? { maxOutputTokens: Number(input.maxOutputTokens) }
              : {}),
            // `null` is the clear-override sentinel. It propagates to
            // updateConfig as null so the live runtime drops the field
            // alongside the disk write.
            ...(input.thinking !== undefined
              ? input.thinking === null
                ? { thinking: null, thinkingBudgetTokens: null }
                : {
                    thinking: String(input.thinking) as "off" | "adaptive" | "enabled",
                  }
              : {}),
            ...(input.thinkingBudgetTokens !== undefined && input.thinking !== null
              ? input.thinkingBudgetTokens === null
                ? { thinkingBudgetTokens: null }
                : { thinkingBudgetTokens: Number(input.thinkingBudgetTokens) }
              : {}),
          });

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

          const allowed = ["displayName", "timezone", "locale", "theme"];
          const patch: Record<string, string> = {};
          for (const [key, value] of Object.entries(input)) {
            if (allowed.includes(key) && value !== undefined) {
              patch[key] = String(value);
            }
          }
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
      annotations: { "ai.nimblebrain/internal": true },
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

          // Admin gating: org admin/owner OR workspace-level admin
          if (identity) {
            if (!ORG_ADMIN_ROLES.has(identity.orgRole)) {
              const ws = await runtime.getWorkspaceStore().get(wsId);
              const member = ws?.members.find((m) => m.userId === identity.id);
              if (member?.role !== "admin") {
                return {
                  content: textContent("Only workspace admins can modify identity."),
                  isError: true,
                };
              }
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
      annotations: { "ai.nimblebrain/internal": true },
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
    // --- Briefing tool (in-process, uses runtime model resolver) ---
    (() => {
      // Per-workspace caches keyed by workspace ID (or "_global" for dev mode)
      const caches = new Map<string, BriefingCache>();

      return {
        name: "briefing",
        description:
          "Generate a personalized activity briefing for the workspace using the fast model slot. Returns a summary of recent activity, upcoming items, and anything needing attention. May take a few seconds.",
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
            const wsDir = runtime.getWorkspaceScopedDir(wsId);

            // Per-workspace cache
            let cache = caches.get(wsId);
            if (!cache) {
              cache = new BriefingCache(homeConfig.cacheTtlMinutes);
              caches.set(wsId, cache);
            }

            // Check cache first
            if (!input.force_refresh) {
              const cached = cache.get();
              if (cached) {
                return {
                  content: textContent("Briefing retrieved from cache."),
                  structuredContent: cached as unknown as Record<string, unknown>,
                  isError: false,
                };
              }
            }

            const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const until = new Date().toISOString();

            // Collect activity from workspace-scoped logs
            const logDir = join(wsDir, "logs");
            const store = runtime.getStore();
            const collector = new ActivityCollector(logDir, store);
            const activity = await collector.collect({ since });

            // Collect briefing facets — scoped to current workspace
            const registry = runtime.getRegistryForCurrentWorkspace();
            const instances = runtime.getBundleInstancesForWorkspace(wsId);

            const facetContext = await collectBriefingFacets(instances, registry, {
              since,
              until,
            });

            // Resolve the model from the "fast" slot
            const modelId = runtime.getModelSlot("fast");
            const model = runtime.resolveModel(modelId);

            // Generate briefing with facets + activity
            const generator = new BriefingGenerator(model, {
              enabled: true,
              model: modelId,
              userName: homeConfig.userName,
              timezone: homeConfig.timezone,
              cacheTtlMinutes: homeConfig.cacheTtlMinutes,
            });
            const briefing: BriefingOutput = await generator.generate(activity, facetContext);

            // Cache the result
            const hash = createHash("md5").update(JSON.stringify(activity.totals)).digest("hex");
            cache.set(briefing, hash);

            return {
              content: textContent("Briefing generated."),
              structuredContent: briefing as unknown as Record<string, unknown>,
              isError: false,
            };
          } catch (err) {
            return {
              content: textContent(
                `Failed to generate briefing: ${err instanceof Error ? err.message : String(err)}`,
              ),
              isError: true,
            };
          }
        },
      } satisfies InProcessTool;
    })(),
  ];

  return toolDefs;
}
