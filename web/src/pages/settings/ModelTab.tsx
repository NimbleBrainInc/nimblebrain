import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select } from "../../components/ui/select";
import { Section, SettingsFormPage } from "./components";

interface ModelEntry {
  id: string;
  cost: { input: string; output: string };
  limits: { context: number };
}

type ThinkingMode = "off" | "adaptive" | "enabled";
type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_DEFAULT = "__default__" as const;

/** Sentinel select value for "no operator override — use platform default policy". */
export const THINKING_DEFAULT = "" as const;

interface ModelConfig {
  models: { default: string; fast: string; reasoning: string };
  configuredProviders: string[];
  availableModels: Record<string, ModelEntry[]>;
  maxIterations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking?: ThinkingMode;
  thinkingEffort?: ThinkingEffort;
  thinkingBudgetTokens?: number;
}

interface Feedback {
  type: "success" | "error";
  message: string;
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

function ModelSelect({
  id,
  label,
  value,
  onChange,
  availableModels,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  availableModels: Record<string, ModelEntry[]>;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select a model</option>
        {Object.entries(availableModels).map(([provider, models]) => (
          <optgroup key={provider} label={provider}>
            {models.map((m) => {
              // Persisted model ids are fully-qualified `provider:id` strings;
              // the resolver routes bare ids to anthropic by default, so a
              // selected `gemini-3.1-pro-preview` would 404 against the
              // Anthropic API. Encode the provider into the option value.
              const qualified = `${provider}:${m.id}`;
              return (
                <option key={qualified} value={qualified}>
                  {m.id} (in: {m.cost.input}, out: {m.cost.output})
                </option>
              );
            })}
          </optgroup>
        ))}
      </Select>
    </div>
  );
}

/**
 * The thinking half of a `set_model_config` patch.
 *
 * Every field is either set or explicitly cleared, never omitted, so a value
 * the operator removed on this screen can't survive on disk from an earlier
 * save. Depth and budget are independent: the budget only reaches providers
 * that meter thinking in tokens, and sending one never voids the chosen depth.
 */
/**
 * Whether a chosen depth reaches the resolver in this mode.
 *
 * True for the default path (which reads `configEffort` with no mode set) and
 * for `enabled`; false for `off` and `adaptive`, which state no depth by
 * definition and return before the resolver looks.
 *
 * The render gate and the save patch both derive from this on purpose. They
 * disagreed once — the control was drawn only for `enabled` while the patch
 * cleared the field everywhere else — which made a depth set through the config
 * file or the admin tool disappear on the next save from this screen.
 */
export function effortAppliesTo(thinking: ThinkingMode | typeof THINKING_DEFAULT): boolean {
  return thinking === THINKING_DEFAULT || thinking === "enabled";
}

export function thinkingPatchFor(
  thinking: ThinkingMode | typeof THINKING_DEFAULT,
  effort: ThinkingEffort | typeof EFFORT_DEFAULT,
  budget: number | null,
): Record<string, unknown> {
  const effortPatch =
    !effortAppliesTo(thinking) || effort === EFFORT_DEFAULT
      ? { clearThinkingEffort: true }
      : { thinkingEffort: effort };

  if (thinking === THINKING_DEFAULT) {
    return { clearThinking: true, ...effortPatch, clearThinkingBudget: true };
  }
  if (thinking !== "enabled") {
    return { thinking, ...effortPatch, clearThinkingBudget: true };
  }
  return {
    thinking,
    ...effortPatch,
    ...(budget == null ? { clearThinkingBudget: true } : { thinkingBudgetTokens: budget }),
  };
}

export function ModelTab() {
  const [defaultModel, setDefaultModel] = useState("");
  const [fastModel, setFastModel] = useState("");
  const [reasoningModel, setReasoningModel] = useState("");
  const [maxIterations, setMaxIterations] = useState(10);
  const [maxInputTokens, setMaxInputTokens] = useState(500000);
  const [maxOutputTokens, setMaxOutputTokens] = useState(16384);
  // Empty string is the "no override — use platform default" sentinel
  // for the select. On save, that becomes a literal `null` to the tool,
  // which clears any persisted operator override.
  const [thinking, setThinking] = useState<ThinkingMode | typeof THINKING_DEFAULT>(
    THINKING_DEFAULT,
  );
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort | typeof EFFORT_DEFAULT>(
    EFFORT_DEFAULT,
  );
  // null = the operator has not set a budget. Seeding a number here and then
  // sending it on save persists a default nobody chose as a deliberate choice.
  const [thinkingBudgetTokens, setThinkingBudgetTokens] = useState<number | null>(null);
  const [availableModels, setAvailableModels] = useState<Record<string, ModelEntry[]>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    callTool("nb", "get_config")
      .then((res) => {
        const config = parseToolResult<ModelConfig>(res);
        const qualify = (id: string | undefined) =>
          qualifyModelId(id, config.availableModels ?? {});
        setDefaultModel(qualify(config.models.default));
        setFastModel(qualify(config.models.fast));
        setReasoningModel(qualify(config.models.reasoning));
        setMaxIterations(config.maxIterations ?? 10);
        setMaxInputTokens(config.maxInputTokens ?? 500000);
        setMaxOutputTokens(config.maxOutputTokens ?? 16384);
        setThinking(config.thinking ?? THINKING_DEFAULT);
        setThinkingEffort(config.thinkingEffort ?? EFFORT_DEFAULT);
        if (config.thinkingBudgetTokens != null) {
          setThinkingBudgetTokens(config.thinkingBudgetTokens);
        }
        setAvailableModels(config.availableModels ?? {});
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load configuration.");
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const thinkingPatch = thinkingPatchFor(thinking, thinkingEffort, thinkingBudgetTokens);

      await callTool("nb", "set_model_config", {
        models: {
          default: defaultModel,
          fast: fastModel,
          reasoning: reasoningModel,
        },
        maxIterations,
        maxInputTokens,
        maxOutputTokens,
        ...thinkingPatch,
      });
      setFeedback({ type: "success", message: "Model configuration saved." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save configuration.";
      setFeedback({ type: "error", message: msg });
    } finally {
      setSaving(false);
    }
  }, [
    defaultModel,
    fastModel,
    reasoningModel,
    maxIterations,
    maxInputTokens,
    maxOutputTokens,
    thinking,
    thinkingEffort,
    thinkingBudgetTokens,
  ]);

  return (
    <SettingsFormPage
      title="Model"
      description="Default model assignments and runtime limits. Applies organization-wide."
      loading={loading}
      loadingMessage="Loading model configuration..."
      loadError={loadError}
      feedback={feedback}
      save={{ onSave: handleSave, saving, disabled: saving }}
    >
      <Section title="Models" flush>
        <div className="space-y-4">
          <ModelSelect
            id="defaultModel"
            label="Default Model"
            value={defaultModel}
            onChange={setDefaultModel}
            availableModels={availableModels}
          />

          <ModelSelect
            id="fastModel"
            label="Fast Model"
            value={fastModel}
            onChange={setFastModel}
            availableModels={availableModels}
          />

          <ModelSelect
            id="reasoningModel"
            label="Reasoning Model"
            value={reasoningModel}
            onChange={setReasoningModel}
            availableModels={availableModels}
          />
        </div>
      </Section>

      <Section title="Limits" description="Runtime caps applied to every conversation.">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="maxIterations">Max Iterations</Label>
            <Input
              id="maxIterations"
              type="number"
              min={1}
              max={25}
              value={maxIterations}
              onChange={(e) => setMaxIterations(Number(e.target.value))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="maxInputTokens">Max Input Tokens</Label>
            <Input
              id="maxInputTokens"
              type="number"
              min={0}
              value={maxInputTokens}
              onChange={(e) => setMaxInputTokens(Number(e.target.value))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="maxOutputTokens">Max Output Tokens</Label>
            <Input
              id="maxOutputTokens"
              type="number"
              min={0}
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
            />
          </div>
        </div>
      </Section>

      <Section
        title="Extended Thinking"
        description="Applies to every provider that supports reasoning. Billed as output tokens; adaptive only engages when the model judges it useful."
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="thinking">Mode</Label>
            <Select
              id="thinking"
              value={thinking}
              onChange={(e) =>
                setThinking(e.target.value as ThinkingMode | typeof THINKING_DEFAULT)
              }
            >
              <option value={THINKING_DEFAULT}>
                Default (reasoning models think at medium effort, others not at all)
              </option>
              <option value="off">
                Off — not enforceable on Opus 4.7/4.8, Sonnet 5, or Opus 5
              </option>
              <option value="adaptive">Adaptive — model decides per call</option>
              <option value="enabled">Enabled — always reason</option>
            </Select>
          </div>

          {effortAppliesTo(thinking) && (
            <div className="space-y-1.5">
              <Label htmlFor="thinkingEffort">Effort</Label>
              <Select
                id="thinkingEffort"
                value={thinkingEffort}
                onChange={(e) =>
                  setThinkingEffort(e.target.value as ThinkingEffort | typeof EFFORT_DEFAULT)
                }
              >
                <option value={EFFORT_DEFAULT}>Default (medium)</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
                <option value="max">Max</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                How hard to think. Applies to the default policy too, not only to Enabled. Carries
                to every provider — models that meter thinking in tokens get a budget sized from it.
              </p>
            </div>
          )}

          {thinking === "enabled" && (
            <div className="space-y-1.5">
              <Label htmlFor="thinkingBudgetTokens">Thinking Budget Tokens</Label>
              <Input
                id="thinkingBudgetTokens"
                type="number"
                min={1024}
                placeholder="Not set — Effort applies"
                value={thinkingBudgetTokens ?? ""}
                onChange={(e) =>
                  setThinkingBudgetTokens(e.target.value === "" ? null : Number(e.target.value))
                }
              />
              <p className="text-xs text-muted-foreground">
                Optional. Min 1024, and capped to leave room for the answer. Only honored by
                providers that meter thinking in tokens (Anthropic up to 4.6, Gemini 2.5); elsewhere
                Effort applies.
              </p>
            </div>
          )}
        </div>
      </Section>
    </SettingsFormPage>
  );
}
