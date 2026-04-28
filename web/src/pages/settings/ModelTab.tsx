import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

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

function parseToolResponse<T>(res: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}): T {
  if (res.isError) throw new Error(res.content?.[0]?.text ?? "Operation failed");
  if (res.structuredContent) return res.structuredContent as T;
  if (res.content?.[0]?.text) {
    try {
      return JSON.parse(res.content[0].text) as T;
    } catch {
      throw new Error(res.content[0].text);
    }
  }
  throw new Error("Empty response");
}

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

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
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={selectClass}
      >
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
      </select>
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

  useEffect(() => {
    callTool("nb", "get_config")
      .then((res) => {
        const config = parseToolResponse<ModelConfig>(res);
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
        const msg = err instanceof Error ? err.message : "Failed to load config.";
        setFeedback({ type: "error", message: msg });
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

  if (loading) {
    return <div className="text-muted-foreground text-sm">Loading model configuration...</div>;
  }

  return (
    <div className="max-w-xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Model Configuration</CardTitle>
          <p className="text-sm text-muted-foreground">
            Configure model slots for different tasks and set runtime limits.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Model Slots */}
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

          {/* Runtime Limits */}
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

          {/* Extended Thinking */}
          <div className="space-y-1.5">
            <Label htmlFor="thinking">Extended Thinking</Label>
            <select
              id="thinking"
              value={thinking}
              onChange={(e) =>
                setThinking(e.target.value as ThinkingMode | typeof THINKING_DEFAULT)
              }
              className={selectClass}
            >
              <option value={THINKING_DEFAULT}>
                Default (adaptive for reasoning models, off otherwise)
              </option>
              <option value="off">Off — never reason</option>
              <option value="adaptive">Adaptive — model decides per call</option>
              <option value="enabled">Enabled — always reason</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Anthropic-only today. Reasoning is billed as output tokens; adaptive only engages when
              the model judges it useful.
            </p>
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

          {/* Feedback */}
          {feedback && (
            <p
              className={
                feedback.type === "success"
                  ? "text-sm text-green-600 dark:text-green-400"
                  : "text-sm text-destructive"
              }
            >
              {feedback.message}
            </p>
          )}

          {/* Save */}
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
