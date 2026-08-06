import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select } from "../../components/ui/select";
import { type ModelEntry, ModelSelect, Section, SettingsFormPage } from "./components";
import {
  EFFORT_DEFAULT,
  THINKING_DEFAULT,
  THINKING_EFFORT_OPTIONS,
  type ThinkingEffort,
  type ThinkingMode,
  thinkingPatchFor,
  tuningAppliesTo,
} from "./thinking-patch";

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

export function ModelTab() {
  const [defaultModel, setDefaultModel] = useState("");
  const [fastModel, setFastModel] = useState("");
  const [resolved, setResolved] = useState<ModelConfig["resolved"] | null>(null);
  const [maxIterations, setMaxIterations] = useState<number | null>(null);
  const [maxInputTokens, setMaxInputTokens] = useState<number | null>(null);
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | null>(null);
  // A cleared numeric field means "unset" — `Number("")` is 0, which would pin a
  // zero cap instead of leaving the field to the runtime default.
  const numberOrNull = (raw: string) => (raw.trim() === "" ? null : Number(raw));

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
        setDefaultModel(qualify(config.models?.default));
        setFastModel(qualify(config.models?.fast));
        setMaxIterations(config.maxIterations ?? null);
        setMaxInputTokens(config.maxInputTokens ?? null);
        setMaxOutputTokens(config.maxOutputTokens ?? null);
        setResolved(config.resolved);
        setThinking(config.thinking ?? THINKING_DEFAULT);
        setThinkingEffort(config.thinkingEffort ?? EFFORT_DEFAULT);
        setThinkingBudgetTokens(config.thinkingBudgetTokens ?? null);
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

      // An empty field means "follow the platform default", and it is sent as
      // an explicit clear rather than by omitting the key — omission means
      // "leave alone", so a cleared field would silently keep its old value.
      // Posting the resolved default back instead would pin a value nobody
      // chose and opt the deployment out of every future change to it.
      const clearable = (value: number | null, key: string, clearFlag: string) =>
        value !== null ? { [key]: value } : { [clearFlag]: true };

      await callTool("nb", "set_model_config", {
        models: { default: defaultModel, fast: fastModel },
        ...clearable(maxIterations, "maxIterations", "clearMaxIterations"),
        ...clearable(maxInputTokens, "maxInputTokens", "clearMaxInputTokens"),
        ...clearable(maxOutputTokens, "maxOutputTokens", "clearMaxOutputTokens"),
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
            placeholder={
              resolved ? `Use the default (${resolved.models.default})` : "Use the default"
            }
          />

          <ModelSelect
            id="fastModel"
            label="Fast Model"
            value={fastModel}
            onChange={setFastModel}
            availableModels={availableModels}
            placeholder={
              resolved
                ? `Follow the default model (${resolved.models.fast})`
                : "Follow the default model"
            }
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
              value={maxIterations ?? ""}
              placeholder={resolved ? String(resolved.maxIterations) : ""}
              onChange={(e) => setMaxIterations(numberOrNull(e.target.value))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="maxInputTokens">Max Input Tokens</Label>
            <Input
              id="maxInputTokens"
              type="number"
              min={0}
              value={maxInputTokens ?? ""}
              placeholder={resolved ? String(resolved.maxInputTokens) : ""}
              onChange={(e) => setMaxInputTokens(numberOrNull(e.target.value))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="maxOutputTokens">Max Output Tokens</Label>
            <Input
              id="maxOutputTokens"
              type="number"
              min={0}
              value={maxOutputTokens ?? ""}
              placeholder={resolved ? String(resolved.maxOutputTokens) : ""}
              onChange={(e) => setMaxOutputTokens(numberOrNull(e.target.value))}
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

          {tuningAppliesTo(thinking) && (
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
                {THINKING_EFFORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                How hard to think. Applies to the default policy too, not only to Enabled. Carries
                to every provider — models that meter thinking in tokens get a budget sized from it.
              </p>
            </div>
          )}

          {tuningAppliesTo(thinking) && (
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
