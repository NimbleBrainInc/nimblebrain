import { useEffect, useId, useMemo, useState } from "react";
import {
  buildInput,
  type FormField,
  type FormValues,
  flatFields,
  initialValues,
} from "../lib/schemaForm.ts";

/** What the editor holds: a run input ready to send, or why it is not. */
export type InputState = { ok: true; input: unknown } | { ok: false; error: string };

/** The JSON a textarea holds, as an input; empty text is no input at all. */
export function parseJsonInput(text: string): InputState {
  if (!text.trim()) return { ok: true, input: undefined };
  try {
    return { ok: true, input: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
  }
}

/** The form's starting values, from a previous input where it has one. */
function seedValues(fields: FormField[] | null, initial: unknown): FormValues {
  if (!fields) return {};
  const v = initialValues(fields);
  if (!initial || typeof initial !== "object") return v;
  for (const f of fields) {
    const prior = (initial as Record<string, unknown>)[f.name];
    if (prior !== undefined) v[f.name] = f.type === "boolean" ? prior === true : String(prior);
  }
  return v;
}

/** What the form holds as an input. */
function formState(errors: Record<string, string>, input: Record<string, unknown>): InputState {
  return Object.keys(errors).length > 0
    ? { ok: false, error: "Fill in the fields marked below." }
    : { ok: true, input };
}

/** One field of the form: a checkbox, a select, or a text or number input. */
function FieldInput({
  id,
  field: f,
  value,
  error,
  onSet,
  onTouch,
}: {
  id: string;
  field: FormField;
  value: string | boolean | undefined;
  error?: string;
  onSet: (v: string | boolean) => void;
  onTouch: () => void;
}) {
  if (f.type === "boolean") {
    return (
      <label className="check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onSet(e.target.checked)}
        />
        {f.name}
      </label>
    );
  }
  const control = f.options ? (
    <select
      id={id}
      className="inline-edit-input"
      value={String(value ?? "")}
      onChange={(e) => onSet(e.target.value)}
    >
      {!f.required && <option value="">—</option>}
      {f.options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  ) : (
    <input
      id={id}
      className="inline-edit-input"
      type={f.type === "string" ? "text" : "number"}
      step={f.type === "integer" ? 1 : "any"}
      value={String(value ?? "")}
      aria-invalid={error ? true : undefined}
      onChange={(e) => onSet(e.target.value)}
      onBlur={onTouch}
    />
  );
  return (
    <>
      <label className="field-label" htmlFor={id}>
        {f.name}
        {f.required && <span className="req"> (required)</span>}
      </label>
      {control}
    </>
  );
}

/** The JSON textarea, with a way back to the form when there is one. */
function JsonInput({
  id,
  text,
  state,
  placeholder,
  onText,
  onUseForm,
}: {
  id: string;
  text: string;
  state: InputState;
  placeholder: string;
  onText: (t: string) => void;
  onUseForm?: () => void;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Input (JSON)
      </label>
      <textarea
        id={id}
        className="inline-edit-textarea code"
        rows={6}
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
      {!state.ok && <div className="field-error">{state.error}</div>}
      {onUseForm && (
        <button type="button" className="link-btn" onClick={onUseForm}>
          Use the form
        </button>
      )}
    </div>
  );
}

/**
 * A run's input: a form drawn from the input schema when the schema is a flat
 * object of scalars, else a JSON textarea. The form can switch to JSON too.
 */
export function InputEditor({
  schema,
  onChange,
  initial,
}: {
  schema?: Record<string, unknown>;
  onChange: (state: InputState) => void;
  /** A previous run's input, to start from. */
  initial?: unknown;
}) {
  const base = useId();
  const fields = useMemo(() => (schema ? flatFields(schema) : null), [schema]);
  const [asJson, setAsJson] = useState(fields === null);
  const [values, setValues] = useState<FormValues>(() => seedValues(fields, initial));
  const [text, setText] = useState(() =>
    initial === undefined ? "" : JSON.stringify(initial, null, 2),
  );
  const [touched, setTouched] = useState(false);

  const form = fields && !asJson ? buildInput(fields, values) : null;
  const state = form ? formState(form.errors, form.input) : parseJsonInput(text);

  const stateKey = JSON.stringify(state);
  // biome-ignore lint/correctness/useExhaustiveDependencies: report when the state's content changes, not its identity
  useEffect(() => {
    onChange(state);
  }, [stateKey]);

  if (!fields || !form) {
    return (
      <JsonInput
        id={`${base}-json`}
        text={text}
        state={state}
        placeholder={schema ? '{ "field": "value" }' : "Optional. Any JSON value."}
        onText={setText}
        onUseForm={fields ? () => setAsJson(false) : undefined}
      />
    );
  }

  return (
    <div className="input-form">
      {fields.length === 0 && <div className="hint">This task takes no input fields.</div>}
      {fields.map((f) => {
        const err = touched ? form.errors[f.name] : undefined;
        return (
          <div className="field" key={f.name}>
            <FieldInput
              id={`${base}-${f.name}`}
              field={f}
              value={values[f.name]}
              error={err}
              onSet={(v) => {
                setTouched(true);
                setValues((prev) => ({ ...prev, [f.name]: v }));
              }}
              onTouch={() => setTouched(true)}
            />
            {f.description && <div className="hint">{f.description}</div>}
            {err && <div className="field-error">{err}</div>}
          </div>
        );
      })}
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          setText(JSON.stringify(form.input, null, 2));
          setAsJson(true);
        }}
      >
        Edit as JSON
      </button>
    </div>
  );
}
