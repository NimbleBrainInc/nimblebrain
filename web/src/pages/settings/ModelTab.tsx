import { useCallback, useEffect, useState } from "react";
import { callToolWithoutWorkspace } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { useAutosaveForm } from "../../hooks/useAutosaveForm";
import {
  AutosaveField,
  AutosaveStatus,
  type ModelEntry,
  ModelSelect,
  Section,
  SettingsFormPage,
} from "./components";
import {
  EFFORT_DEFAULT,
  type ModelConfigField,
  type ModelConfigValues,
  modelConfigPatch,
  THINKING_DEFAULT,
  THINKING_EFFORT_OPTIONS,
  type ThinkingEffort,
  type ThinkingMode,
  tuningAppliesTo,
} from "./model-config-patch";

/**
 * `get_config`'s two groups. The top level is what the operator set — every
 * field optional, because absent means "not set" and is the only way to tell
 * that from "set to today's default". `resolved` is the effective value, shown
 * as placeholder text and never sent back.
 */
interface ModelConfig {
  models?: { default?: string; fast?: string };
  maxIterations?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  resolved: {
    models: { default: string; fast: string };
    maxIterations: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  configuredProviders: string[];
  availableModels: Record<string, ModelEntry[]>;
  thinking?: ThinkingMode;
  thinkingEffort?: ThinkingEffort;
  thinkingBudgetTokens?: number;
}

// Qualify bare model ids (legacy disk state from older UI versions that wrote
// `m.id` without the `provider:` prefix). Without this, those bare ids don't
// match any option value and the dropdown shows the placeholder even though
// routing works at runtime via the catalog fallback in `resolveModelString`.
// Re-saving with a qualified value also migrates the persisted state.
/** Resolve a possibly-bare model id to a fully-qualified `provider:id` using the catalog. */
function qualifyModelId(
  id: string | undefined,
  availableModels: Record<string, ModelEntry[]>,
): string {
  if (!id) return "";
  if (id.includes(":")) return id;
  for (const [provider, models] of Object.entries(availableModels)) {
    if (models.some((m) => m.id === id)) return `${provider}:${id}`;
  }
  return id; // unknown — leave as-is so the field still shows the value
}

const EMPTY: ModelConfigValues = {
  defaultModel: "",
  fastModel: "",
  maxIterations: "",
  maxInputTokens: "",
  maxOutputTokens: "",
  thinking: THINKING_DEFAULT,
  thinkingEffort: EFFORT_DEFAULT,
  thinkingBudgetTokens: "",
};

const LABELS: Record<ModelConfigField, string> = {
  defaultModel: "Default Model",
  fastModel: "Fast Model",
  maxIterations: "Max Iterations",
  maxInputTokens: "Max Input Tokens",
  maxOutputTokens: "Max Output Tokens",
  thinking: "Thinking mode",
  thinkingEffort: "Thinking effort",
  thinkingBudgetTokens: "Thinking Budget Tokens",
};

const ALL_UNDO = Object.fromEntries(
  Object.keys(LABELS).map((field) => [field, { undo: true }]),
) as Record<ModelConfigField, { undo: true }>;

/** What the operator set, as the form's field values. An unset field is empty. */
function toValues(config: ModelConfig): ModelConfigValues {
  const qualify = (id: string | undefined) => qualifyModelId(id, config.availableModels ?? {});
  const text = (n: number | undefined) => (n === undefined ? "" : String(n));
  return {
    defaultModel: qualify(config.models?.default),
    fastModel: qualify(config.models?.fast),
    maxIterations: text(config.maxIterations),
    maxInputTokens: text(config.maxInputTokens),
    maxOutputTokens: text(config.maxOutputTokens),
    thinking: config.thinking ?? THINKING_DEFAULT,
    thinkingEffort: config.thinkingEffort ?? EFFORT_DEFAULT,
    thinkingBudgetTokens: text(config.thinkingBudgetTokens),
  };
}

const readConfig = async () =>
  parseToolResult<ModelConfig>(await callToolWithoutWorkspace("nb", "get_config"));

/**
 * Settings → Model. Each field saves as it changes (`useAutosaveForm`): a
 * select on choice, a number on blur or Enter.
 *
 * Every field applies to every conversation in the org the moment it saves,
 * so each save raises a notice with Undo.
 */
export function ModelTab() {
  const [resolved, setResolved] = useState<ModelConfig["resolved"] | null>(null);
  const [availableModels, setAvailableModels] = useState<Record<string, ModelEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const save = useCallback(
    async <K extends ModelConfigField>(field: K, value: ModelConfigValues[K]) => {
      const res = await callToolWithoutWorkspace(
        "nb",
        "set_model_config",
        modelConfigPatch(field, value),
      );
      // A refusal comes back as a result, not a throw; without this it would
      // be reported as saved.
      if (res.isError) throw new Error(res.content?.[0]?.text ?? "The change was not saved.");
    },
    [],
  );

  // A save changes what `resolved` reports: clearing an override moves its
  // field's placeholder to the new effective value. Only `resolved` is read
  // back — the fields hold what the operator is editing, and a re-read would
  // overwrite an edit made while the save was in flight. The save has already
  // landed, so a failed re-read only leaves the old placeholder.
  const onSaved = useCallback(() => {
    readConfig()
      .then((config) => setResolved(config.resolved))
      .catch(() => {});
  }, []);

  const form = useAutosaveForm(EMPTY, {
    save,
    onSaved,
    labels: LABELS,
    notices: ALL_UNDO,
  });
  const { load, revert } = form;

  // A mode that ignores depth and budget hides their fields. One that failed
  // to save, or holds an edit not yet saved, would leave the page reporting a
  // change nobody can see to retry or revert, so it goes back to its saved
  // value. An effect rather than the select's handler, so a save that fails
  // after the field is hidden is caught too.
  const tuningShown = tuningAppliesTo(form.values.thinking);
  const effortStatus = form.fieldState("thinkingEffort").status;
  const budgetStatus = form.fieldState("thinkingBudgetTokens").status;
  useEffect(() => {
    if (tuningShown) return;
    if (effortStatus === "error" || effortStatus === "dirty") revert("thinkingEffort");
    if (budgetStatus === "error" || budgetStatus === "dirty") revert("thinkingBudgetTokens");
  }, [tuningShown, effortStatus, budgetStatus, revert]);

  useEffect(() => {
    readConfig()
      .then((config) => {
        load(toValues(config));
        setResolved(config.resolved);
        setAvailableModels(config.availableModels ?? {});
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load configuration.");
      })
      .finally(() => setLoading(false));
  }, [load]);

  const { values } = form;
  const numberField = (
    field: "maxIterations" | "maxInputTokens" | "maxOutputTokens",
    placeholder: string,
  ) => (
    <AutosaveField id={field} label={LABELS[field]} {...form.fieldState(field)}>
      <Input
        id={field}
        type="number"
        min={field === "maxIterations" ? 1 : 0}
        max={field === "maxIterations" ? 25 : undefined}
        placeholder={placeholder}
        {...form.inputProps(field)}
      />
    </AutosaveField>
  );

  return (
    <SettingsFormPage
      title="Model"
      description="Default model assignments and runtime limits. Applies organization-wide."
      action={loading || loadError ? undefined : <AutosaveStatus status={form.status} />}
      loading={loading}
      loadingMessage="Loading model configuration..."
      loadError={loadError}
    >
      <div className="min-w-0 space-y-6">
        <Section title="Models" flush>
          <div className="space-y-4">
            <AutosaveField
              id="defaultModel"
              label={LABELS.defaultModel}
              {...form.fieldState("defaultModel")}
            >
              <ModelSelect
                id="defaultModel"
                value={values.defaultModel}
                onChange={(v) => form.commit("defaultModel", v)}
                invalid={form.fieldState("defaultModel").status === "error"}
                availableModels={availableModels}
                placeholder={
                  resolved ? `Use the default (${resolved.models.default})` : "Use the default"
                }
              />
            </AutosaveField>

            <AutosaveField
              id="fastModel"
              label={LABELS.fastModel}
              {...form.fieldState("fastModel")}
            >
              <ModelSelect
                id="fastModel"
                value={values.fastModel}
                onChange={(v) => form.commit("fastModel", v)}
                invalid={form.fieldState("fastModel").status === "error"}
                availableModels={availableModels}
                placeholder={
                  resolved
                    ? `Follow the default model (${resolved.models.fast})`
                    : "Follow the default model"
                }
              />
            </AutosaveField>
          </div>
        </Section>

        <Section title="Limits" description="Runtime caps applied to every conversation.">
          <div className="space-y-4">
            {numberField("maxIterations", resolved ? String(resolved.maxIterations) : "")}
            {numberField("maxInputTokens", resolved ? String(resolved.maxInputTokens) : "")}
            {numberField("maxOutputTokens", resolved ? String(resolved.maxOutputTokens) : "")}
          </div>
        </Section>

        <Section
          title="Extended Thinking"
          description="Applies to every provider that supports reasoning. Billed as output tokens; adaptive only engages when the model judges it useful."
        >
          <div className="space-y-4">
            <AutosaveField id="thinking" label="Mode" {...form.fieldState("thinking")}>
              <Select id="thinking" {...form.selectProps("thinking")}>
                <option value={THINKING_DEFAULT}>
                  Default (reasoning models think at medium effort, others not at all)
                </option>
                <option value="off">
                  Off — not enforceable on Opus 4.7/4.8, Sonnet 5, or Opus 5
                </option>
                <option value="adaptive">Adaptive — model decides per call</option>
                <option value="enabled">Enabled — always reason</option>
              </Select>
            </AutosaveField>

            {tuningAppliesTo(values.thinking) && (
              <AutosaveField
                id="thinkingEffort"
                label="Effort"
                {...form.fieldState("thinkingEffort")}
                hint="How hard to think. Applies to the default policy too, not only to Enabled. Carries to every provider — models that meter thinking in tokens get a budget sized from it."
              >
                <Select id="thinkingEffort" {...form.selectProps("thinkingEffort")}>
                  <option value={EFFORT_DEFAULT}>Default (medium)</option>
                  {THINKING_EFFORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </AutosaveField>
            )}

            {tuningAppliesTo(values.thinking) && (
              <AutosaveField
                id="thinkingBudgetTokens"
                label={LABELS.thinkingBudgetTokens}
                {...form.fieldState("thinkingBudgetTokens")}
                hint="Optional. Min 1024, and capped to leave room for the answer. Only honored by providers that meter thinking in tokens (Anthropic up to 4.6, Gemini 2.5); elsewhere Effort applies."
              >
                <Input
                  id="thinkingBudgetTokens"
                  type="number"
                  min={1024}
                  placeholder="Not set — Effort applies"
                  {...form.inputProps("thinkingBudgetTokens")}
                />
              </AutosaveField>
            )}
          </div>
        </Section>
      </div>
    </SettingsFormPage>
  );
}
