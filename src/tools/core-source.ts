import { readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactResolutionsTotal } from "../api/metrics.ts";
import { OVERRIDE_WRITABLE_KEYS } from "../config/overrides.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ThinkingEffort, ToolResult } from "../engine/types.ts";
import {
  type ArtifactListItem,
  type ArtifactListOptions,
  ArtifactNotFoundError,
  ArtifactTooLargeError,
  getArtifactResolver,
  InvalidArtifactUriError,
} from "../host-resources/artifacts/index.ts";
import { ORG_ADMIN_ROLES } from "../identity/types.ts";
import { getAvailableModels, isModelAllowed, isModelInPolicy } from "../model/catalog.ts";
import { resolveModelString } from "../model/registry.ts";
import { isModelSlot, MODEL_SLOTS } from "../model/slots.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { InProcessTool } from "./in-process-app.ts";
import { McpSource } from "./mcp-source.ts";
import { createOpenAppTool } from "./open-app.ts";
import { SharedSourceRef } from "./registry.ts";

const pkgPath = resolve(import.meta.dirname ?? __dirname, "../../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
// Prefer the build-time-injected git tag; fall back to package.json for local dev.
const VERSION = process.env.NB_VERSION || pkg.version;

import type { BriefingItem, BriefingOutput } from "../platform/schemas/home.ts";
import { createBriefingCollector } from "../services/briefing-collector.ts";
import { WORKSPACE_OPTIONAL_META } from "./workspace-optional.ts";

// --- set_model_config helpers -------------------------------------------------
// The handler is a linear validate → normalize → merge → write pipeline; each
// stage is factored out so no single function carries the whole decision tree.
// Validators return an error message (surfaced as an `isError` tool result) or
// null when the field is absent or valid.

/** Valid `thinkingEffort` values, in ascending depth. Mirrors `ThinkingEffort`. */
const THINKING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingEffort[];

/**
 * Every scalar field an operator can set, each with its `clear*` flag and
 * on-disk coercion.
 *
 * Driven from a table because they all move together through four stages —
 * normalize, validate, persist, patch the live runtime. Written out longhand,
 * a new field has to be remembered in each, and a clear that lands on some
 * stages but not others leaves disk and process disagreeing.
 *
 * Every settable field needs a clear, or "unset" becomes a state the operator
 * can leave but never return to: the first save pins a value permanently and
 * the deployment stops tracking the platform default. A separate boolean
 * rather than a `null` value keeps each field's schema type single — which
 * Gemini's function-calling subset requires. Model slots are absent from this
 * table because they clear with `""`; see `mergeModelSlots`.
 */
const CLEARABLE_FIELDS = [
  { key: "thinking", clearFlag: "clearThinking", coerce: String },
  { key: "thinkingEffort", clearFlag: "clearThinkingEffort", coerce: String },
  { key: "thinkingBudgetTokens", clearFlag: "clearThinkingBudget", coerce: Number },
  { key: "maxIterations", clearFlag: "clearMaxIterations", coerce: Number },
  { key: "maxInputTokens", clearFlag: "clearMaxInputTokens", coerce: Number },
  { key: "maxOutputTokens", clearFlag: "clearMaxOutputTokens", coerce: Number },
] as const;

/** Org-admin gate. */
function checkModelConfigAccess(runtime: Runtime): string | null {
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
 *
 * The three fields are independent. Clearing `thinking` used to cascade onto
 * the other two on the grounds that a depth or a budget means nothing without
 * a mode — that stopped being true when the resolver's no-mode path started
 * reading both: an effort alone selects the tier, and a budget alone resolves
 * to `enabled` at that budget. Cascading now deletes settings that are still
 * in force, and rejects the payload the settings UI sends for its own default
 * mode.
 */
function normalizeModelConfigClears(input: Record<string, unknown>): string | null {
  for (const { key, clearFlag } of CLEARABLE_FIELDS) {
    if (input[clearFlag] !== true) continue;
    if (input[key] != null) {
      return `Cannot set both \`${key}\` and \`${clearFlag}\`. Use one or the other.`;
    }
    input[key] = null;
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
  // `null` is the normalized clear sentinel, not a value to range-check.
  // `Number(null)` is 0, which would fail every one of these floors.
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    return max !== undefined
      ? `${label} must be an integer between ${min} and ${max}.`
      : `${label} must be a positive integer.`;
  }
  return null;
}

function unreachableModelError(model: string, runtime: Runtime, slot?: string): string | null {
  const subject = slot ? `Invalid model "${model}" for slot "${slot}"` : `Invalid model "${model}"`;
  // Qualified before the policy check: `isModelInPolicy` is an exact match on
  // `provider:id`, and a bare id is legal input here — legacy saved values and
  // the settings tab both pass one through.
  if (!isModelInPolicy(resolveModelString(model), runtime.getModelPolicy())) {
    return `${subject}. It is not in this organization's allowed models.`;
  }
  if (isModelAllowed(model, runtime.getProviderConfigs())) return null;
  return `${subject}. Either the provider is not configured or the model is not in the allowlist. Configured providers: ${runtime.getConfiguredProviders().join(", ")}`;
}

function validateModelSlots(input: Record<string, unknown>, runtime: Runtime): string | null {
  if (input.models === undefined || typeof input.models !== "object") return null;
  for (const [slot, value] of Object.entries(input.models as Record<string, unknown>)) {
    if (!isModelSlot(slot)) {
      return `Unknown model slot "${slot}". Valid slots: ${MODEL_SLOTS.join(", ")}.`;
    }
    // `""` clears the slot; there is no model to check the allowlist against.
    const model = String(value);
    if (model === "") continue;
    const error = unreachableModelError(model, runtime, slot);
    if (error) return error;
  }
  return null;
}

/**
 * After this write, does every slot still point inside the policy in force?
 *
 * Narrower than it looks: a slot pointed *at* a forbidden model is already
 * refused upstream by `validateModelSlots`, which checks each named value. What
 * reaches here is the case no named value covers — a slot **cleared** with
 * `""`, which falls back to a default the list may not contain.
 */
function policyStrandingError(input: Record<string, unknown>, runtime: Runtime): string | null {
  const effective = runtime.getModelPolicy();
  if (!effective || effective.length === 0) return null;
  return strandedSlotError(input, runtime, effective);
}

/**
 * Would this allowed-list leave a slot pointing outside it once the call lands?
 *
 * Judged on the **post-write** slots, which the runtime computes — an earlier
 * version derived them here from `input.models` alone and missed the deprecated
 * `defaultModel` input, which also repoints the default slot, while rejecting
 * the `""` clear because it read the sentinel as a model name.
 *
 * Read from `configuredModelSlots`, not `getDefaultModel`: the latter is tinted
 * by the calling admin's own preference, so an admin whose personal model
 * happens to be in the list would pass a guard every other member fails.
 *
 * Every slot, because a configured slot is never re-tested at read time — this
 * write is the only thing standing between a policy and a turn that resolves to
 * a model the org forbids.
 */
function strandedSlotError(
  input: Record<string, unknown>,
  runtime: Runtime,
  allowed: string[],
): string | null {
  const pendingDefault = typeof input.defaultModel === "string" ? input.defaultModel : undefined;
  const slots = runtime.configuredModelSlots({
    models: (input.models ?? {}) as Partial<Record<string, string>>,
    ...(pendingDefault !== undefined ? { defaultModel: pendingDefault } : {}),
  });

  for (const slot of MODEL_SLOTS) {
    if (!allowed.includes(slots[slot])) {
      return `Cannot exclude "${slots[slot]}", which the ${slot} slot uses. Point that slot at an allowed model first, in this call or before it.`;
    }
  }

  return null;
}

/**
 * A field this tool does not write.
 *
 * The success line is built from the caller's own keys, so an unwritten field
 * was reported as applied — an admin narrowing the allowlist was told it
 * worked while nothing changed. Rejecting is better than filtering the
 * summary: the caller asked for something, and silence about it is the same
 * lie one layer quieter.
 */
function unwritableFieldError(input: Record<string, unknown>): string | null {
  const writable = new Set<string>([
    ...OVERRIDE_WRITABLE_KEYS,
    ...CLEARABLE_FIELDS.map((f) => f.clearFlag),
  ]);
  for (const key of Object.keys(input)) {
    if (input[key] === undefined || writable.has(key)) continue;
    if (key === "modelPolicy") {
      return "`modelPolicy` is not set here. It is deployment configuration — set `modelPolicy.allowed` in nimblebrain.json.";
    }
    return `\`${key}\` is not a field this tool writes.`;
  }
  return null;
}

/** The deprecated top-level `defaultModel` input. `models.default` supersedes it. */
function validateDefaultModel(input: Record<string, unknown>, runtime: Runtime): string | null {
  if (input.defaultModel === undefined) return null;
  return unreachableModelError(String(input.defaultModel), runtime);
}

function validateModelConfigLimits(input: Record<string, unknown>): string | null {
  return (
    positiveIntFieldError(input.maxIterations, "maxIterations", 1, 50) ??
    positiveIntFieldError(input.maxInputTokens, "maxInputTokens", 1) ??
    positiveIntFieldError(input.maxOutputTokens, "maxOutputTokens", 1)
  );
}

function validateModelConfigThinking(input: Record<string, unknown>): string | null {
  if (input.thinking !== undefined && input.thinking !== null) {
    const v = String(input.thinking);
    if (v !== "off" && v !== "adaptive" && v !== "enabled") {
      return 'thinking must be "off", "adaptive", "enabled", or null (clear override).';
    }
  }
  if (input.thinkingEffort !== undefined && input.thinkingEffort !== null) {
    if (!(THINKING_EFFORTS as readonly string[]).includes(String(input.thinkingEffort))) {
      return `thinkingEffort must be one of ${THINKING_EFFORTS.join(", ")}, or null (clear override).`;
    }
  }
  if (input.thinkingBudgetTokens !== undefined && input.thinkingBudgetTokens !== null) {
    const n = Number(input.thinkingBudgetTokens);
    if (!Number.isInteger(n) || n < 1024) {
      return "thinkingBudgetTokens must be a positive integer ≥ 1024 (Anthropic minimum).";
    }
  }
  return null;
}

/** All of set_model_config's input validation, in order. */
function validateModelConfigPatch(input: Record<string, unknown>, runtime: Runtime): string | null {
  return (
    unwritableFieldError(input) ??
    validateModelSlots(input, runtime) ??
    validateDefaultModel(input, runtime) ??
    policyStrandingError(input, runtime) ??
    validateModelConfigLimits(input) ??
    validateModelConfigThinking(input)
  );
}

/** Merge only the model slots, key-by-key so an override of one slot leaves the others. */
function mergeModelSlots(existing: Record<string, unknown>, input: Record<string, unknown>): void {
  if (input.models === undefined || typeof input.models !== "object") return;
  if (!existing.models || typeof existing.models !== "object") existing.models = {};
  const existingModels = existing.models as Record<string, unknown>;
  for (const [slot, value] of Object.entries(input.models as Record<string, unknown>)) {
    // `""` clears the slot, mirroring the live-config path in `updateConfig`.
    if (String(value) === "") delete existingModels[slot];
    else existingModels[slot] = String(value);
  }
  // Leave no empty husk behind: `"models": {}` in the override file reads as a
  // section the operator configured.
  if (Object.keys(existingModels).length === 0) delete existing.models;
}

/** Merge the validated patch into the on-disk override object (mutates `existing`). */
function mergeModelConfigOverride(
  existing: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  mergeModelSlots(existing, input);
  if (input.defaultModel !== undefined) existing.defaultModel = String(input.defaultModel);
  // null = clear the operator override; undefined = leave alone. Fields are
  // independent: clearing the thinking mode does not clear the depth or budget.
  for (const { key, coerce } of CLEARABLE_FIELDS) {
    if (input[key] === null) delete existing[key];
    else if (input[key] !== undefined) existing[key] = coerce(input[key]);
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
  // `null` reaches updateConfig verbatim: it gates on `!== undefined`, so a
  // clear expressed as `undefined` would write to disk and never reach the
  // live process.
  const scalarPatch: Record<string, unknown> = {};
  for (const { key, coerce } of CLEARABLE_FIELDS) {
    if (input[key] === null) scalarPatch[key] = null;
    else if (input[key] !== undefined) scalarPatch[key] = coerce(input[key]);
  }
  return {
    ...(modelsPatch ? { models: modelsPatch } : {}),
    ...(input.defaultModel !== undefined ? { defaultModel: String(input.defaultModel) } : {}),
    ...scalarPatch,
  };
}

// --- set_preferences helpers --------------------------------------------------

const PREFERENCE_FIELDS = ["displayName", "timezone", "locale", "theme"];

/**
 * Coerce the allowed preference inputs into a patch, skipping unset fields.
 *
 * The scalar fields stringify; `model` does not travel with them. It is the
 * one preference that has to be a structured value on the user record
 * (`preferences.models.default`), and running it through the same `String()`
 * path would store `[object Object]`.
 */
function buildPreferencesPatch(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (PREFERENCE_FIELDS.includes(key) && value !== undefined) {
      patch[key] = String(value);
    }
  }
  if (input.model !== undefined) {
    // Null and empty both clear. Empty matters because `get_config` reports an
    // unset preference as `""`, so a client that reads preferences and writes
    // them back sends exactly that — and storing it would pin the user to an
    // empty model id they cannot correct without a working turn.
    const chosen = typeof input.model === "string" ? input.model.trim() : "";
    patch.models = chosen ? { default: resolveModelString(chosen) } : {};
  }
  return patch;
}

/**
 * Reject a model choice the deployment does not permit, so a person is told at
 * the point of choosing rather than finding their preference silently ignored
 * on the next turn. `getModelSlots` re-checks on read for the case this cannot
 * cover: an allowlist narrowed after the preference was saved.
 */
function preferredModelError(input: Record<string, unknown>, runtime: Runtime): string | null {
  if (typeof input.model !== "string") return null;
  const chosen = input.model.trim();
  if (chosen === "") return null; // clearing, nothing to validate
  if (runtime.isModelPermitted(chosen)) return null;
  const qualified = resolveModelString(chosen);
  return `Model "${qualified}" is not permitted. Either its provider is not configured or it is not in the allowlist. Configured providers: ${runtime.getConfiguredProviders().join(", ") || "(none)"}`;
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

/** One line per item, for the tool result's `content`. */
function renderBriefingText(items: BriefingItem[]): string {
  if (items.length === 0) return "Nothing is waiting in this workspace's apps.";
  return items
    .map((item) =>
      item.state === "ok"
        ? `${item.count} ${item.label} (${item.app})`
        : `${item.label} (${item.app}): unavailable`,
    )
    .join("\n");
}

/**
 * The workspace's MCP source for a connector, unwrapped from a shared ref, or
 * null when the workspace has none by that name.
 */
function workspaceMcpSource(runtime: Runtime, wsId: string, serverName: string): McpSource | null {
  const source = runtime
    .getRegistryForWorkspace(wsId)
    .getSources()
    .find((s) => s.name === serverName);
  const unwrapped = source instanceof SharedSourceRef ? source.unwrap() : source;
  return unwrapped instanceof McpSource ? unwrapped : null;
}

/**
 * Factory that creates core platform management tool definitions.
 * Each tool is a thin wrapper delegating to Runtime methods.
 * Returns raw InProcessTool[] — caller (the `nb` system source factory)
 * passes them to `defineInProcessApp` to build the in-process MCP server.
 */
export function createCoreToolDefs(runtime: Runtime): InProcessTool[] {
  // One collector per runtime: its listing and count caches are keyed by
  // workspace, server and facet, never by the member who asked.
  const briefingCollector = createBriefingCollector({
    resolveSource: (wsId, serverName) => workspaceMcpSource(runtime, wsId, serverName),
    connectorTitles: () => runtime.connectorTitles(),
  });

  const toolDefs: InProcessTool[] = [
    {
      name: "get_config",
      description:
        "Get current runtime configuration: default model, configured providers, and limits.",
      meta: { ui: { visibility: ["app"] }, ...WORKSPACE_OPTIONAL_META },
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (): Promise<ToolResult> => {
        try {
          const identity = runtime.getCurrentIdentity();
          const preferences = identity?.preferences ?? {};
          return {
            content: textContent("Current runtime configuration."),
            structuredContent: {
              // Two groups, and the split is the contract: everything at the
              // top level is what the operator actually set and is safe to
              // send back to `set_model_config`. Everything under `resolved`
              // is the effective value after defaults — display only. Writing
              // a resolved value back turns a default nobody chose into an
              // override that outlives every future change to it.
              ...runtime.getOperatorConfig(),
              // What THIS caller's next conversation will be created with —
              // their preference when they have a permitted one, the
              // configured default otherwise. Published because the precedence
              // is the runtime's to decide: a client deriving it from the two
              // fields below would be keeping a second copy of the rule.
              newConversationModel: runtime.getDefaultModel(),
              resolved: {
                // Untinted by the caller's own profile and workspace. This
                // feeds the settings tab, which posts back on Save, and it
                // labels what "use the default" means — publishing the
                // caller's own view would let an admin persist their personal
                // model as everyone's default.
                models: runtime.configuredModelSlots(),
                maxIterations: runtime.getMaxIterations(),
                maxInputTokens: runtime.getMaxInputTokens(),
                maxOutputTokens: runtime.getMaxOutputTokens(),
              },
              configuredProviders: runtime.getConfiguredProviders(),
              availableModels: getAvailableModels(
                runtime.getProviderConfigs(),
                runtime.getModelPolicy(),
              ),
              preferences: {
                displayName: identity?.displayName ?? "",
                timezone: preferences.timezone ?? "",
                locale: preferences.locale ?? "en-US",
                theme: preferences.theme ?? "system",
                // Empty when unset, so a client can tell "following the
                // configured default" from "chose this model deliberately".
                model: preferences.models?.default ?? "",
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
      meta: { ui: { visibility: ["app"] }, ...WORKSPACE_OPTIONAL_META },
      inputSchema: {
        type: "object",
        properties: {
          models: {
            type: "object",
            description: "Role-based model slots. Each slot maps to a provider:model-id string.",
            properties: {
              default: {
                type: "string",
                description: "Primary model for chat. Empty string clears the slot.",
              },
              fast: {
                type: "string",
                description:
                  "Cheap/fast model for auxiliary tasks. Empty string clears the slot (falls back to the default model).",
              },
            },
          },
          defaultModel: {
            type: "string",
            description: "Default model ID. Deprecated — use models.default instead.",
          },
          maxIterations: {
            type: "number",
            description:
              "Max agentic iterations per request (1-25). Use clearMaxIterations=true to revert to the platform default.",
          },
          clearMaxIterations: {
            type: "boolean",
            description:
              "If true, clears any persisted max-iterations override. Mutually exclusive with `maxIterations`.",
          },
          maxInputTokens: {
            type: "number",
            description:
              "Max input tokens per request (must be > 0). Use clearMaxInputTokens=true to revert to the platform default.",
          },
          clearMaxInputTokens: {
            type: "boolean",
            description:
              "If true, clears any persisted max-input-tokens override. Mutually exclusive with `maxInputTokens`.",
          },
          maxOutputTokens: {
            type: "number",
            description:
              "Max output tokens per LLM call (must be > 0). Use clearMaxOutputTokens=true to revert to the model-derived default.",
          },
          clearMaxOutputTokens: {
            type: "boolean",
            description:
              "If true, clears any persisted max-output-tokens override. Mutually exclusive with `maxOutputTokens`.",
          },
          thinking: {
            type: "string",
            enum: ["off", "adaptive", "enabled"],
            description:
              "Extended-thinking mode for reasoning-capable models. " +
              "off: never reason. adaptive: model decides per call. " +
              "enabled: always reason, at thinkingEffort. " +
              "Use clearThinking=true to revert to the platform default.",
          },
          clearThinking: {
            type: "boolean",
            description:
              "If true, clears any persisted thinking override and reverts to the platform default. " +
              "Mutually exclusive with `thinking`.",
          },
          thinkingEffort: {
            type: "string",
            enum: [...THINKING_EFFORTS],
            description:
              "How hard to think when reasoning is on. The portable control — every " +
              "reasoning-capable provider can express a depth. Applies to thinking=enabled " +
              "and to the platform default. Use clearThinkingEffort=true to revert.",
          },
          clearThinkingEffort: {
            type: "boolean",
            description:
              "If true, clears any persisted thinking effort. Mutually exclusive with `thinkingEffort`.",
          },
          thinkingBudgetTokens: {
            type: "number",
            description:
              "Explicit token budget for thinking, for metering in tokens rather than " +
              "naming a depth. Only honored by providers that meter thinking in tokens " +
              "(Anthropic up to 4.6, Gemini 2.5); elsewhere thinkingEffort applies — " +
              "Gemini 3 takes a level, not a budget. " +
              "Counts toward maxOutputTokens. Anthropic requires a minimum of 1,024.",
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
        "Set user preferences: display name, timezone, locale, theme, or the model this user's new conversations run on. Use this when the user says their name, asks to change timezone/language/theme, or asks to use a particular model.",
      meta: { ...WORKSPACE_OPTIONAL_META },
      inputSchema: {
        type: "object",
        properties: {
          displayName: { type: "string", description: "User's display name (e.g., 'Matt')." },
          timezone: { type: "string", description: "IANA timezone (e.g., 'Pacific/Honolulu')." },
          locale: { type: "string", description: "BCP 47 locale (e.g., 'en-US')." },
          theme: { type: "string", enum: ["system", "light", "dark"], description: "Color theme." },
          model: {
            type: ["string", "null"],
            description:
              "Model for this user's new conversations, as `provider:model-id`. Applies to conversations started after the change — an existing one keeps the model it was created with. Null clears the choice and follows the configured default. Auxiliary models (title generation, briefing, compaction) are operator-configured and not settable here.",
          },
        },
      },
      handler: async (input): Promise<ToolResult> => {
        try {
          const identity = runtime.getCurrentIdentity();
          if (!identity) {
            return { content: textContent("No authenticated user."), isError: true };
          }

          const modelError = preferredModelError(input, runtime);
          if (modelError) return { content: textContent(modelError), isError: true };

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
      name: "workspace_info",
      description:
        "Get workspace metadata: platform version, telemetry status, and install ID. Used by the web client on startup.",
      meta: { ui: { visibility: ["app"] }, ...WORKSPACE_OPTIONAL_META },
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
    // --- Briefing tool: the workspace's open counts, read from its apps ---
    {
      name: "briefing",
      description:
        "List what is waiting in this workspace's apps: one item per facet an app's server reports through the ai.nimblebrain/facets extension, with its count and the app to open. The same for every member.",
      meta: { ui: { visibility: ["app"] } },
      inputSchema: {
        type: "object",
        properties: {
          force_refresh: {
            type: "boolean",
            description: "Re-read every facet instead of serving cached counts. Default: false.",
          },
        },
      },
      handler: async (input): Promise<ToolResult> => {
        try {
          const wsId = runtime.requireWorkspaceId();
          const items = await briefingCollector.collect(
            wsId,
            runtime.getConnectorInstancesForWorkspace(wsId),
            { force: input.force_refresh === true },
          );
          const output: BriefingOutput = { items, generated_at: new Date().toISOString() };
          return {
            content: textContent(renderBriefingText(items)),
            structuredContent: output as unknown as Record<string, unknown>,
            isError: false,
          };
        } catch (err) {
          return {
            content: textContent(
              `Failed to collect the briefing: ${err instanceof Error ? err.message : String(err)}`,
            ),
            isError: true,
          };
        }
      },
    },
    createOpenAppTool(runtime),
  ];

  return toolDefs;
}
