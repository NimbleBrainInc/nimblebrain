import { Label } from "../../../components/ui/label";
import { Select } from "../../../components/ui/select";

export interface ModelEntry {
  id: string;
  cost: { input: string; output: string };
  limits: { context: number };
}

/**
 * A model picker over the catalog `get_config` publishes, grouped by provider.
 *
 * `availableModels` already has deprecated entries stripped and the provider
 * allowlist applied, so what renders here is what the deployment will accept —
 * the same list the admin and the profile surfaces both pick from.
 */
export function ModelSelect({
  id,
  label,
  value,
  onChange,
  availableModels,
  placeholder = "Select a model",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  availableModels: Record<string, ModelEntry[]>;
  /** Text for the empty option — the caller says what "no selection" means. */
  placeholder?: string;
}) {
  // A `<select>` cannot display a value with no matching option — it falls back
  // to showing the first one. So a stored model the catalog no longer carries
  // (deprecated, or permitted but uncatalogued) would render as the empty
  // option while state still holds the real value, telling the reader they are
  // on the default when they are not, and posting the hidden value on save.
  const known = Object.entries(availableModels).some(([provider, models]) =>
    models.some((m) => `${provider}:${m.id}` === value),
  );

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {value && !known && <option value={value}>{value} (not in the current catalog)</option>}
        {Object.entries(availableModels).map(([provider, models]) => (
          <optgroup key={provider} label={provider}>
            {models.map((m) => {
              // Stored model ids are fully-qualified `provider:id`. A bare id
              // routes to anthropic by default, so a selected
              // `gemini-3.1-pro-preview` would 404 against the Anthropic API.
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
