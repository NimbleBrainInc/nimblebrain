import { useId } from "react";
import { type BuilderField, builderProblem, type FieldType } from "../lib/schemaForm.ts";

/** Rows of simple input fields (name, type, required, description) that make a flat input schema. */
export function InputFieldsBuilder({
  rows,
  onChange,
}: {
  rows: BuilderField[];
  onChange: (rows: BuilderField[]) => void;
}) {
  const base = useId();
  const problem = builderProblem(rows);
  const set = (i: number, patch: Partial<BuilderField>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="fields-builder">
      {rows.length === 0 && (
        <p className="hint">
          No input: every run gets the same prompt. Add a field to pass one value per run.
        </p>
      )}
      {rows.map((r, i) => {
        const id = `${base}-${i}`;
        return (
          <fieldset key={id} className="builder-row">
            <legend className="sr-only">Input field {i + 1}</legend>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-n`}>
                Name
              </label>
              <input
                id={`${id}-n`}
                className="inline-edit-input"
                value={r.name}
                placeholder="company"
                onChange={(e) => set(i, { name: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-t`}>
                Type
              </label>
              <select
                id={`${id}-t`}
                className="inline-edit-input"
                value={r.type}
                onChange={(e) => set(i, { type: e.target.value as FieldType })}
              >
                <option value="string">Text</option>
                <option value="number">Number</option>
                <option value="integer">Whole number</option>
                <option value="boolean">Yes / no</option>
              </select>
            </div>
            <div className="field field-grow">
              <label className="field-label" htmlFor={`${id}-d`}>
                Description
              </label>
              <input
                id={`${id}-d`}
                className="inline-edit-input"
                value={r.description}
                onChange={(e) => set(i, { description: e.target.value })}
              />
            </div>
            <label className="check builder-req">
              <input
                type="checkbox"
                checked={r.required}
                onChange={(e) => set(i, { required: e.target.checked })}
              />
              Required
            </label>
            <button
              type="button"
              className="btn btn-icon"
              aria-label={`Remove field ${r.name || i + 1}`}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </fieldset>
        );
      })}
      {problem && <div className="field-error">{problem}</div>}
      <button
        type="button"
        className="btn"
        onClick={() =>
          onChange([...rows, { name: "", type: "string", required: true, description: "" }])
        }
      >
        Add a field
      </button>
    </div>
  );
}
