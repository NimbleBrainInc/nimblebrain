import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import { getAvailableModels, isModelAllowed } from "../model/catalog.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { InlineToolDef } from "./inline-source.ts";

const pkgPath = resolve(import.meta.dirname ?? __dirname, "../../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
  name: string;
  version: string;
  dependencies: Record<string, string>;
};

import { ActivityCollector } from "../services/activity-collector.ts";
import { BriefingCache } from "../services/briefing-cache.ts";
import { collectBriefingFacets } from "../services/briefing-collector.ts";
import { BriefingGenerator } from "../services/briefing-generator.ts";
import type { BriefingOutput } from "../services/home-types.ts";

/**
 * Factory that creates core platform management tool definitions.
 * Each tool is a thin wrapper delegating to Runtime methods.
 * Returns raw InlineToolDef[] — caller is responsible for wrapping in an InlineSource.
 */
export function createCoreToolDefs(runtime: Runtime): InlineToolDef[] {
  const toolDefs: InlineToolDef[] = [
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
          content: textContent(`${pkg.name} v${pkg.version}`),
          structuredContent: {
            name: pkg.name,
            version: pkg.version,
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
        },
      },
      handler: async (input): Promise<ToolResult> => {
        try {
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

          // Read current config
          let existing: Record<string, unknown> = {};
          try {
            const raw = await readFile(configPath, "utf-8");
            existing = JSON.parse(raw);
          } catch {
            // File doesn't exist or invalid — start fresh
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
            const ORG_ADMIN_ROLES = new Set(["admin", "owner"]);
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
            `Workspace v${pkg.version}, telemetry ${tm.isEnabled() ? "enabled" : "disabled"}.`,
          ),
          structuredContent: {
            version: pkg.version,
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
      } satisfies InlineToolDef;
    })(),
  ];

  return toolDefs;
}
