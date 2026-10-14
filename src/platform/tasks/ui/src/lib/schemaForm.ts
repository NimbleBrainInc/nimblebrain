/**
 * A run's input form, drawn from the task's `inputSchema` when the schema is
 * a flat object of scalars, and the inverse for the editor's field builder.
 * Anything richer (nested objects, arrays, `oneOf`) is edited as raw JSON:
 * a form that could not express the schema would quietly send the wrong shape.
 */

export type FieldType = "string" | "number" | "integer" | "boolean";

/** One form field, from one property of a flat object schema. */
export interface FormField {
  name: string;
  type: FieldType;
  required: boolean;
  description?: string;
  /** A string property's `enum`: the field is a select. */
  options?: string[];
}

/** The value a form holds for each field: text for inputs, a boolean for checkboxes. */
export type FormValues = Record<string, string | boolean>;

const SCALARS: readonly string[] = ["string", "number", "integer", "boolean"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The fields of a flat object schema, in property order, or null when the
 * schema is not one a form can hold (so the caller falls back to JSON).
 */
export function flatFields(schema: unknown): FormField[] | null {
  if (!isRecord(schema)) return null;
  if (schema.type !== "object" || !isRecord(schema.properties)) return null;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  const fields: FormField[] = [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    const field = fieldOf(name, prop, required.includes(name));
    if (!field) return null;
    fields.push(field);
  }
  return fields;
}

/** One property as a form field, or null when it is not a scalar a form can hold. */
function fieldOf(name: string, prop: unknown, required: boolean): FormField | null {
  if (!isRecord(prop) || typeof prop.type !== "string" || !SCALARS.includes(prop.type)) {
    return null;
  }
  const field: FormField = { name, type: prop.type as FieldType, required };
  if (typeof prop.description === "string") field.description = prop.description;
  if (Array.isArray(prop.enum)) {
    const options = prop.enum;
    if (prop.type !== "string" || !options.every((o) => typeof o === "string")) return null;
    field.options = options as string[];
  }
  return field;
}

/** The starting values: empty text, unchecked boxes, the first option of a required select. */
export function initialValues(fields: FormField[]): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    if (f.type === "boolean") values[f.name] = false;
    else values[f.name] = f.options && f.required ? (f.options[0] ?? "") : "";
  }
  return values;
}

/**
 * The run input a filled form makes, or the reason each bad field is bad.
 * An empty optional field is left out; booleans are always sent.
 */
export function buildInput(
  fields: FormField[],
  values: FormValues,
): { input: Record<string, unknown>; errors: Record<string, string> } {
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const read = readField(f, values[f.name]);
    if (read.error) errors[f.name] = read.error;
    else if (read.value !== undefined) input[f.name] = read.value;
  }
  return { input, errors };
}

/** One field's value as the input takes it, or why it is bad; neither for an empty optional field. */
function readField(
  f: FormField,
  raw: string | boolean | undefined,
): { value?: unknown; error?: string } {
  if (f.type === "boolean") return { value: raw === true };
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return f.required ? { error: "Required" } : {};
  if (f.type === "string") {
    return f.options && !f.options.includes(text)
      ? { error: "Pick one of the options" }
      : { value: text };
  }
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: "Enter a number" };
  if (f.type === "integer" && !Number.isInteger(n)) return { error: "Enter a whole number" };
  return { value: n };
}

/** One row of the editor's input-field builder. */
export interface BuilderField {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
}

/** A property name the builder accepts: what a CSV header or a prompt can name plainly. */
export const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** The schema the builder's rows describe; null for no rows (no input schema at all). */
export function schemaFromFields(rows: BuilderField[]): Record<string, unknown> | null {
  if (rows.length === 0) return null;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const r of rows) {
    properties[r.name] = {
      type: r.type,
      ...(r.description.trim() ? { description: r.description.trim() } : {}),
    };
    if (r.required) required.push(r.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** The builder rows for a schema, or null when the builder cannot represent it. */
export function fieldsFromSchema(schema: unknown): BuilderField[] | null {
  const fields = flatFields(schema);
  if (!fields || fields.some((f) => f.options)) return null;
  return fields.map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
    description: f.description ?? "",
  }));
}

/** Why the builder's rows cannot be saved, or null when they can. */
export function builderProblem(rows: BuilderField[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    if (!FIELD_NAME_RE.test(r.name)) {
      return `"${r.name || "(blank)"}" is not a field name: start with a letter, then letters, digits, or _.`;
    }
    if (seen.has(r.name)) return `Two fields are named "${r.name}".`;
    seen.add(r.name);
  }
  return null;
}
