/**
 * A JSON Schema inferred from one value, for the editor's "infer from the test
 * run's output". Every key seen is required; an array takes its first item's
 * shape. A starting point to edit, not a judgement about the output.
 */
export function inferSchema(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return value.length > 0 ? { type: "array", items: inferSchema(value[0]) } : { type: "array" };
  }
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "boolean":
      return { type: "boolean" };
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number" };
    case "object": {
      const entries = Object.entries(value as Record<string, unknown>);
      return {
        type: "object",
        properties: Object.fromEntries(entries.map(([k, v]) => [k, inferSchema(v)])),
        required: entries.map(([k]) => k),
      };
    }
    default:
      return {};
  }
}

/** The deliverable as JSON when it is JSON (a fenced ```json block included), else undefined. */
export function parseJsonOutput(output: string): unknown {
  const fenced = output.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  const text = fenced ? (fenced[1] as string) : output.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
