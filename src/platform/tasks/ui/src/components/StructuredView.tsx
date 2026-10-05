import type { ReactNode } from "react";

/** Most columns a table of records shows; the rest stay readable in the JSON view. */
const MAX_COLUMNS = 8;
const URL_RE = /^https?:\/\/\S+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The columns of a list of records: every key seen, in first-seen order, capped. */
export function recordColumns(rows: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!keys.includes(k)) keys.push(k);
      if (keys.length === MAX_COLUMNS) return keys;
    }
  }
  return keys;
}

function Scalar({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="sv-null">—</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "string" && URL_RE.test(value)) {
    return (
      <a href={value} target="_blank" rel="noreferrer noopener">
        {value}
      </a>
    );
  }
  return <span>{String(value)}</span>;
}

/**
 * A structured deliverable as a person reads it: an object as labelled
 * values, a list of records as a table, a list of scalars as a list. Nested
 * values recurse.
 */
export function StructuredValue({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}): ReactNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="sv-null">None</span>;
    if (value.every(isRecord)) {
      const cols = recordColumns(value);
      return (
        <div className="sv-table-wrap">
          <table className="sv-table">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows of a fixed deliverable
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c}>
                      <StructuredValue value={row[c]} depth={depth + 1} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return (
      <ul className="sv-list">
        {value.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: items of a fixed deliverable
          <li key={i}>
            <StructuredValue value={v} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    return (
      <dl className={depth === 0 ? "sv-dl" : "sv-dl sv-dl-nested"}>
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="sv-pair">
            <dt>{k}</dt>
            <dd>
              <StructuredValue value={v} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <Scalar value={value} />;
}

/** Text without a surrounding Markdown code fence (```json … ```), closed or cut off. */
export function unfence(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\s*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

/** A JSON deliverable's text as a value, a fenced block included; undefined for anything else. */
export function asJson(text: string): unknown {
  const body = unfence(text);
  if (!body.startsWith("{") && !body.startsWith("[")) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * A deliverable as a person reads it: structured output (or text that is
 * JSON) as labelled values and tables, with the raw JSON behind "Show raw";
 * anything else as wrapped prose. Nothing scrolls sideways.
 */
export function ResultPreview({ structured, text }: { structured?: unknown; text?: string }) {
  const value = structured !== undefined ? structured : text ? asJson(text) : undefined;
  if (value !== null && typeof value === "object") {
    return (
      <div className="result-preview">
        <StructuredValue value={value} />
        <details className="raw">
          <summary>Show raw</summary>
          <pre className="code-block">{JSON.stringify(value, null, 2)}</pre>
        </details>
      </div>
    );
  }
  return text ? <p className="prose result-preview">{unfence(text)}</p> : null;
}
