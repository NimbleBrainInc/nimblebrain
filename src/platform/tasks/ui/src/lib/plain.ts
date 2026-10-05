/**
 * Plain words for what the runtime reports in codes, the one way the panel
 * writes a run's time, and a run's input in a few words.
 */

/**
 * Why a run was not judged (or judged as it was), as a sentence with the next
 * step. The code itself is never shown; an unknown one reads as a judge error.
 */
export function assessmentReasonText(code: string): string {
  switch (code) {
    case "no_judge":
      return "No judge is connected, so these rules couldn't be checked. Connect a judge in Connectors.";
    case "judge_ambiguous":
      return "More than one judge is connected. Name the one to use in the task's editor, then re-judge.";
    case "judge_not_found":
      return "The judge this task names isn't connected. Pick a connected judge in the task's editor.";
    case "schema_invalid":
      return "The result doesn't match the task's output schema.";
    case "nothing_to_check":
      return "The task has no rules or output schema, so there was nothing to check.";
    case "no_result":
      return "The run left no result to check.";
    case "owner_not_member":
      return "The task's owner is no longer in this workspace, so the judge couldn't be called.";
    case "upstream_timeout":
      return "The judge took too long to answer. Re-judge to try again.";
    case "rate_limited":
    case "upstream_unavailable":
    case "judge_unavailable":
      return "The judge isn't available right now. Re-judge to try again.";
    default:
      return "The judge couldn't answer. Re-judge to try again.";
  }
}

const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** A run's start as the panel writes it everywhere: "Today 4:08 PM", "Yesterday 9:15 AM", "Oct 4, 4:08 PM". */
export function runTime(iso: string, now: number = Date.now()): string {
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
