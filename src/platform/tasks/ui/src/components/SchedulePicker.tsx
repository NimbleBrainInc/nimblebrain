import { useState } from "react";

export interface ScheduleSpec {
  type: "cron" | "interval" | "once";
  expression?: string;
  timezone?: string;
  intervalMs?: number;
  /** When a `once` fires: an ISO-8601 instant (the picker emits UTC, `…Z`). */
  at?: string;
}
// NOTE: if you add a field here, add it to `specEqual` below — the reconcile
// relies on a structural compare, and an unaccounted field silently reintroduces
// the display-desync bug this component was fixed for.

/** `manual` is no schedule at all: the picker emits `null`, and only Run now runs it. */
export type ScheduleMode = "interval" | "daily" | "weekly" | "cron" | "once" | "manual";

export const DAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

/**
 * A cron minute or hour the `HH:MM` input can hold: one in-range number.
 *
 * `*`, a list (`12,17`), a range (`9-17`) and a step (`*` with `/15`) each name
 * more than one moment, and the daily/weekly modes render exactly one time.
 * Out-of-range digits (`25` as an hour) are no more holdable than those, so the
 * bound is part of the question rather than a separate validation.
 */
function namesOneMoment(field: string | undefined, max: number): boolean {
  if (field === undefined || !/^\d{1,2}$/.test(field)) return false;
  return Number(field) <= max;
}

export function detectMode(spec: ScheduleSpec | null): ScheduleMode {
  if (!spec) return "manual";
  if (spec.type === "interval") return "interval";
  if (spec.type === "once") return "once";
  if (!spec.expression) return "cron";
  const parts = spec.expression.trim().split(/\s+/);
  if (parts.length !== 5) return "cron";
  const [min, hour, dom, mon, dow] = parts;
  // A mode is only offered for an expression it can represent. Daily and weekly
  // render one `HH:MM`, so they require a minute and hour that name a single
  // moment; the day fields alone do not decide that. Anything else belongs to
  // `cron`, whose raw text field round-trips verbatim.
  if (!namesOneMoment(min, 59) || !namesOneMoment(hour, 23)) return "cron";
  if (dom === "*" && mon === "*" && dow === "*") return "daily";
  if (dom === "*" && mon === "*" && dow !== "*") return "weekly";
  return "cron";
}

/**
 * The expression a structured mode produces. Exported so the round-trip is
 * testable against the real builder — a copy in the test would pass while this
 * one changed underneath it.
 */
export function cronFor(mode: "daily" | "weekly", time: string, dow: string): string {
  const [h, min] = time.split(":").map(Number);
  return mode === "daily" ? `${min} ${h} * * *` : `${min} ${h} * * ${dow}`;
}

export function parseTime(spec: ScheduleSpec | null): string {
  if (!spec?.expression) return "08:00";
  const parts = spec.expression.trim().split(/\s+/);
  // Five fields, matching `detectMode`. These read minute and hour by position,
  // so the six-field seconds form — which the server's cron library accepts —
  // shifts every field one place and yields an in-range time the expression
  // does not name.
  if (parts.length !== 5) return "08:00";
  // Seeded for every spec, including one shown in `cron` mode — the user can
  // switch to Daily/Weekly at any time and `emit` reads this state directly.
  // A field the input cannot hold therefore falls back to the default rather
  // than riding through as a string `Number` turns into NaN.
  const h = namesOneMoment(parts[1], 23) ? parts[1]! : "8";
  const m = namesOneMoment(parts[0], 59) ? parts[0]! : "0";
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

export function parseDow(spec: ScheduleSpec | null): string {
  if (!spec?.expression) return "1";
  const parts = spec.expression.trim().split(/\s+/);
  // Same arity gate as `parseTime`, for the same reason: on a six-field
  // expression position 4 is the month, so a June schedule would read as
  // Saturday.
  return parts.length === 5 && parts[4] !== "*" ? parts[4]! : "1";
}

export function specEqual(a: ScheduleSpec | null, b: ScheduleSpec | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.type === b.type &&
    a.expression === b.expression &&
    a.timezone === b.timezone &&
    a.intervalMs === b.intervalMs &&
    a.at === b.at
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * An ISO instant as a `datetime-local` input value (`YYYY-MM-DDTHH:MM`) in the
 * browser's own time zone, or "" when it is not a valid instant.
 */
export function localInputFromIso(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/**
 * A `datetime-local` value, read in the browser's own time zone, as a UTC ISO
 * instant: the offset-qualified form the server requires. "" when empty or
 * unparseable, which the server refuses with a message saying what it needs.
 */
export function isoFromLocalInput(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** The default time a new once schedule offers: the next whole hour, local time. */
export function defaultOnceLocal(now: number = Date.now()): string {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return localInputFromIso(d.toISOString());
}

export function SchedulePicker({
  value,
  onChange,
  timezone = "Pacific/Honolulu",
}: {
  /** `null`: no schedule (manual only). */
  value: ScheduleSpec | null;
  onChange: (spec: ScheduleSpec | null) => void;
  timezone?: string;
}) {
  const [mode, setMode] = useState<ScheduleMode>(() => detectMode(value));
  const [minutes, setMinutes] = useState(() =>
    value?.type === "interval" && value.intervalMs ? value.intervalMs / 60_000 : 30,
  );
  const [time, setTime] = useState(() => parseTime(value));
  const [dow, setDow] = useState(() => parseDow(value));
  const [cronExpr, setCronExpr] = useState(() => value?.expression ?? "");
  const [onceAt, setOnceAt] = useState(() => localInputFromIso(value?.at) || defaultOnceLocal());

  // Reconcile display state to externally-driven `value` changes (e.g. choosing
  // a template pre-fills the parent's schedule after this picker has mounted).
  // The state atoms above are seeded once at mount; without this, an external
  // `value` change would leave the radio/fields showing stale state while the
  // parent submits the new value — the picker would show "Every 30 minutes"
  // but save the template's "Daily at 8".
  //
  // We must NOT re-derive on the picker's own edits, or switching modes would
  // clobber cross-mode field memory (e.g. a typed-but-unsubmitted weekly time).
  // The discriminator is provenance-by-value: we track the last spec the picker
  // emitted in state and re-derive only when the incoming `value` doesn't match
  // it — i.e. an external change. A structural compare (not reference identity)
  // means this holds even for a caller that clones/normalizes in `onChange`,
  // and keeping it in state (not a ref) keeps this render pure / StrictMode-safe
  // — `setState` during render is replayed idempotently; a render-phase ref
  // write would not be.
  const [lastSpec, setLastSpec] = useState<ScheduleSpec | null>(value);
  if (!specEqual(value, lastSpec)) {
    setLastSpec(value);
    setMode(detectMode(value));
    if (value?.type === "interval" && value.intervalMs) setMinutes(value.intervalMs / 60_000);
    setTime(parseTime(value));
    setDow(parseDow(value));
    setCronExpr(value?.expression ?? "");
    if (value?.type === "once") setOnceAt(localInputFromIso(value.at));
  }

  function emit(
    m: ScheduleMode,
    mins: number,
    t: string,
    d: string,
    cron: string,
    once: string = onceAt,
  ) {
    let spec: ScheduleSpec | null;
    if (m === "manual") {
      spec = null;
    } else if (m === "once") {
      spec = { type: "once", at: isoFromLocalInput(once) };
    } else if (m === "interval") {
      spec = { type: "interval", intervalMs: Math.max(1, mins) * 60_000 };
    } else if (m === "daily" || m === "weekly") {
      spec = { type: "cron", expression: cronFor(m, t, d), timezone };
    } else {
      spec = { type: "cron", expression: cron, timezone };
    }
    // Record what we emitted so the reconcile above recognizes the parent's
    // resulting `value` update as ours (structurally equal) and skips re-derive.
    setLastSpec(spec);
    onChange(spec);
  }

  function handleMode(m: ScheduleMode) {
    setMode(m);
    emit(m, minutes, time, dow, cronExpr);
  }

  return (
    <div className="sched-picker">
      {/* Every N minutes */}
      <label className="sched-option">
        <input
          type="radio"
          name="schedule-mode"
          checked={mode === "interval"}
          onChange={() => handleMode("interval")}
        />
        <span>Every</span>
        <input
          type="number"
          min={1}
          value={minutes}
          onChange={(e) => {
            const v = Number(e.target.value);
            setMinutes(v);
            if (mode === "interval") emit("interval", v, time, dow, cronExpr);
          }}
          onFocus={() => handleMode("interval")}
          className="sched-input" style={{ width: 56 }}
        />
        <span>minutes</span>
      </label>

      {/* Daily at time */}
      <label className="sched-option">
        <input
          type="radio"
          name="schedule-mode"
          checked={mode === "daily"}
          onChange={() => handleMode("daily")}
        />
        <span>Daily at</span>
        <input
          type="time"
          value={time}
          onChange={(e) => {
            setTime(e.target.value);
            if (mode === "daily") emit("daily", minutes, e.target.value, dow, cronExpr);
          }}
          onFocus={() => handleMode("daily")}
          className="sched-input" style={{ width: 100 }}
        />
      </label>

      {/* Weekly on day at time */}
      <label className="sched-option">
        <input
          type="radio"
          name="schedule-mode"
          checked={mode === "weekly"}
          onChange={() => handleMode("weekly")}
        />
        <span>Weekly on</span>
        <select
          value={dow}
          onChange={(e) => {
            setDow(e.target.value);
            if (mode === "weekly") emit("weekly", minutes, time, e.target.value, cronExpr);
          }}
          onFocus={() => handleMode("weekly")}
          className="sched-input" style={{ width: "auto" }}
        >
          {DAYS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
        <span>at</span>
        <input
          type="time"
          value={time}
          onChange={(e) => {
            setTime(e.target.value);
            if (mode === "weekly") emit("weekly", minutes, e.target.value, dow, cronExpr);
          }}
          onFocus={() => handleMode("weekly")}
          className="sched-input" style={{ width: 100 }}
        />
      </label>

      {/* Custom cron */}
      <label className="sched-option">
        <input
          type="radio"
          name="schedule-mode"
          checked={mode === "cron"}
          onChange={() => handleMode("cron")}
        />
        <span>Custom cron:</span>
        <input
          type="text"
          value={cronExpr}
          onChange={(e) => {
            setCronExpr(e.target.value);
            if (mode === "cron") emit("cron", minutes, time, dow, e.target.value);
          }}
          onFocus={() => handleMode("cron")}
          placeholder="0 8 * * *"
          className="sched-input" style={{ width: 120 }}
        />
      </label>

      {/* Once at a date and time, then it stops */}
      <label className="sched-option">
        <input
          type="radio"
          name="schedule-mode"
          checked={mode === "once"}
          onChange={() => handleMode("once")}
        />
        <span>Once at</span>
        <input
          type="datetime-local"
          value={onceAt}
          onChange={(e) => {
            setOnceAt(e.target.value);
            if (mode === "once") emit("once", minutes, time, dow, cronExpr, e.target.value);
          }}
          onFocus={() => handleMode("once")}
          className="sched-input" style={{ width: 190 }}
        />
      </label>

      {/* No schedule */}
      <label className="sched-option">
        <input
          type="radio"
          name="schedule-mode"
          checked={mode === "manual"}
          onChange={() => handleMode("manual")}
        />
        <span>Manual only</span>
        <span className="muted">
          runs only when you run it
        </span>
      </label>
    </div>
  );
}
