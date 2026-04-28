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

/** Sentinel select value for "no operator override — use platform default policy". */
const THINKING_DEFAULT = "" as const;

interface ModelConfig {
  models: { default: string; fast: string; reasoning: string };
  configuredProviders: string[];
  availableModels: Record<string, ModelEntry[]>;
  maxIterations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking?: ThinkingMode;
  thinkingBudgetTokens?: number;
}

interface Feedback {
  type: "success" | "error";
  message: string;
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
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} (in: {m.cost.input}, out: {m.cost.output})
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </div>
  );
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
  const [thinkingBudgetTokens, setThinkingBudgetTokens] = useState(16000);
  const [availableModels, setAvailableModels] = useState<Record<string, ModelEntry[]>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    callTool("nb", "get_config")
      .then((res) => {
        const config = parseToolResult<ModelConfig>(res);
        setDefaultModel(config.models.default ?? "");
        setFastModel(config.models.fast ?? "");
        setReasoningModel(config.models.reasoning ?? "");
        setMaxIterations(config.maxIterations ?? 10);
        setMaxInputTokens(config.maxInputTokens ?? 500000);
        setMaxOutputTokens(config.maxOutputTokens ?? 16384);
        setThinking(config.thinking ?? THINKING_DEFAULT);
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
      // null → clear operator override (revert to platform default policy)
      // string mode → set explicit override
      // budget only sent for "enabled"; "off"/"adaptive" don't need it
      const thinkingPatch =
        thinking === THINKING_DEFAULT
          ? { thinking: null, thinkingBudgetTokens: null }
          : thinking === "enabled"
            ? { thinking, thinkingBudgetTokens }
            : { thinking };

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
        description="Anthropic-only today. Reasoning is billed as output tokens; adaptive only engages when the model judges it useful."
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
                Default (adaptive for reasoning models, off otherwise)
              </option>
              <option value="off">Off — never reason</option>
              <option value="adaptive">Adaptive — model decides per call</option>
              <option value="enabled">Enabled — always reason</option>
            </Select>
          </div>

          {thinking === "enabled" && (
            <div className="space-y-1.5">
              <Label htmlFor="thinkingBudgetTokens">Thinking Budget Tokens</Label>
              <Input
                id="thinkingBudgetTokens"
                type="number"
                min={1024}
                value={thinkingBudgetTokens}
                onChange={(e) => setThinkingBudgetTokens(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Min 1024. Counts toward Max Output Tokens.
              </p>
            </div>
          )}
        </div>
      </Section>
    </SettingsFormPage>
  );
}
