/**
 * Plain words for what the plugin reports in codes, the one way the panel
 * writes a run's time, and a run's input in a few words.
 */

/**
 * Why a run's assessment reads as it does, as a sentence. The code itself is
 * never shown; one this screen does not know reads as a generic line.
 */
export function assessmentReasonText(code: string): string {
  switch (code) {
    case "schema_invalid":
      return "The result doesn't match the task's output schema.";
    case "nothing_to_check":
      return "The task has no output schema, so there was nothing to check.";
    case "no_result":
      return "The run left no result to check.";
    default:
      return "The result could not be checked.";
  }
}

const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** A run's start as the panel writes it everywhere: "Today 4:08 PM", "Yesterday 9:15 AM", "Oct 4, 4:08 PM". */
export function runTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((day(now) - day(d.getTime())) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, TIME);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", ...TIME });
}

/** A run's name, the same in its crumb, its page heading, and its rows: "Run Yesterday 4:08 PM". */
export function runName(startedAt: string | undefined, now: number = Date.now()): string {
  return startedAt ? `Run ${runTime(startedAt, now)}` : "Run";
}

const MAX_SUMMARY = 48;

/**
 * A run's input in a few words: the first required field's value when the
 * input schema names one, else the first text value, cut to a short line.
 * Undefined when the run had no input worth showing.
 */
export function inputSummary(input: unknown, schema?: Record<string, unknown>): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object") return cut(String(input));
  if (Array.isArray(input)) return input.length > 0 ? `${input.length} items` : undefined;
  const record = input as Record<string, unknown>;
  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    const v = record[key];
    if (typeof v === "string" || typeof v === "number") return cut(String(v));
  }
  const first = Object.values(record).find((v) => typeof v === "string" && v.trim());
  return typeof first === "string" ? cut(first) : undefined;
}

function cut(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > MAX_SUMMARY ? `${t.slice(0, MAX_SUMMARY - 1)}…` : t;
}
