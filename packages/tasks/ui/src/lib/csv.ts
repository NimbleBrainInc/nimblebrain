/**
 * Batch items from pasted text: a JSON array as is, or CSV whose header row
 * names the input schema's fields, each cell coerced to its field's type.
 */
import { type FormField, flatFields } from "./schemaForm.ts";

/** Read a quoted cell starting after its opening quote; returns the cell and the index after its closing quote. */
function readQuoted(text: string, from: number): [string, number] {
  let cell = "";
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' && text[i + 1] === '"') {
      cell += '"';
      i += 2;
    } else if (ch === '"') {
      return [cell, i + 1];
    } else {
      cell += ch;
      i++;
    }
  }
  return [cell, i];
}

/** Parse CSV (RFC 4180: quoted cells, doubled quotes, CRLF or LF). Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = "";
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const [quoted, next] = readQuoted(text, i + 1);
      cell += quoted;
      i = next;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else cell += ch;
    i++;
  }
  endRow();
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface ParsedItems {
  items: unknown[];
  /** Problems that stop the batch; empty when the items are good. */
  errors: string[];
  format: "json" | "csv" | "empty";
}

/** At most this many row problems are listed; the rest are counted. */
const MAX_LISTED = 5;

function coerceCell(field: FormField | undefined, cell: string): unknown {
  const text = cell.trim();
  if (!field || field.type === "string") return cell;
  if (field.type === "boolean") {
    if (/^(true|yes|1)$/i.test(text)) return true;
    if (/^(false|no|0)$/i.test(text)) return false;
    throw new Error("is not true or false");
  }
  const n = Number(text);
  if (text === "" || !Number.isFinite(n)) throw new Error("is not a number");
  if (field.type === "integer" && !Number.isInteger(n)) throw new Error("is not a whole number");
  return n;
}

/** CSV rows as items keyed by header, coerced to the schema's field types. */
export function itemsFromCsv(text: string, schema?: unknown): ParsedItems {
  const rows = parseCsv(text);
  if (rows.length === 0) return { items: [], errors: [], format: "empty" };
  const header = (rows[0] ?? []).map((h) => h.trim());
  const fields = schema ? flatFields(schema) : null;
  const byName = new Map((fields ?? []).map((f) => [f.name, f]));
  const errors: string[] = [];
  if (header.some((h) => h === "")) errors.push("The header row has a blank column name.");
  if (fields) {
    const closed = (schema as Record<string, unknown>).additionalProperties === false;
    const unknown = header.filter((h) => h && !byName.has(h));
    if (closed && unknown.length > 0) {
      errors.push(`Columns not in the task's input: ${unknown.join(", ")}.`);
    }
    const missing = fields.filter((f) => f.required && !header.includes(f.name));
    if (missing.length > 0) {
      errors.push(`Missing required columns: ${missing.map((f) => f.name).join(", ")}.`);
    }
  }
  if (errors.length > 0) return { items: [], errors, format: "csv" };

  const items: unknown[] = [];
  const rowErrors: string[] = [];
  rows.slice(1).forEach((cells, r) => {
    if (cells.length > header.length) {
      rowErrors.push(`Row ${r + 1} has ${cells.length} cells for ${header.length} columns.`);
      return;
    }
    const item: Record<string, unknown> = {};
    header.forEach((name, c) => {
      const cell = cells[c] ?? "";
      const field = byName.get(name);
      // An empty cell is an absent value, so an optional field stays optional.
      if (cell.trim() === "") return;
      try {
        item[name] = coerceCell(field, cell);
      } catch (err) {
        rowErrors.push(`Row ${r + 1}, ${name}: "${cell}" ${(err as Error).message}.`);
      }
    });
    for (const f of fields ?? []) {
      if (f.required && (item[f.name] === undefined || item[f.name] === "")) {
        rowErrors.push(`Row ${r + 1}: ${f.name} is required.`);
      }
    }
    items.push(item);
  });
  if (rowErrors.length > MAX_LISTED) {
    const more = rowErrors.length - MAX_LISTED;
    rowErrors.splice(MAX_LISTED, rowErrors.length, `…and ${more} more.`);
  }
  if (rowErrors.length > 0) return { items: [], errors: rowErrors, format: "csv" };
  if (items.length === 0)
    return { items: [], errors: ["No rows under the header."], format: "csv" };
  return { items, errors: [], format: "csv" };
}

/** Pasted items: a JSON array when the text starts with `[`, else CSV. */
export function parseItems(text: string, schema?: unknown): ParsedItems {
  const trimmed = text.trim();
  if (!trimmed) return { items: [], errors: [], format: "empty" };
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed))
        return { items: [], errors: ["Not a JSON array."], format: "json" };
      if (parsed.length === 0) {
        return { items: [], errors: ["The array is empty."], format: "json" };
      }
      return { items: parsed, errors: [], format: "json" };
    } catch (err) {
      return { items: [], errors: [`Not valid JSON: ${(err as Error).message}`], format: "json" };
    }
  }
  return itemsFromCsv(trimmed, schema);
}
