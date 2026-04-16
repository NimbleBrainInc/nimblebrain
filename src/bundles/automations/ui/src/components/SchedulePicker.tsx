import { useState } from "react";

export interface ScheduleSpec {
  type: "cron" | "interval";
  expression?: string;
  timezone?: string;
  intervalMs?: number;
}

export type ScheduleMode = "interval" | "daily" | "weekly" | "cron";

export const DAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

export function detectMode(spec: ScheduleSpec | null): ScheduleMode {
  if (!spec) return "interval";
  if (spec.type === "interval") return "interval";
  if (!spec.expression) return "cron";
  const parts = spec.expression.trim().split(/\s+/);
  if (parts.length !== 5) return "cron";
  const [, , dom, mon, dow] = parts;
  if (dom === "*" && mon === "*" && dow === "*") return "daily";
  if (dom === "*" && mon === "*" && dow !== "*") return "weekly";
  return "cron";
}

export function parseTime(spec: ScheduleSpec | null): string {
  if (!spec?.expression) return "08:00";
  const parts = spec.expression.trim().split(/\s+/);
  if (parts.length < 2) return "08:00";
  const h = parts[1] === "*" ? "8" : parts[1]!;
  const m = parts[0] === "*" ? "0" : parts[0]!;
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

export function parseDow(spec: ScheduleSpec | null): string {
  if (!spec?.expression) return "1";
  const parts = spec.expression.trim().split(/\s+/);
  return parts.length >= 5 && parts[4] !== "*" ? parts[4]! : "1";
}

export function SchedulePicker({
  value,
  onChange,
  timezone = "Pacific/Honolulu",
}: {
  value: ScheduleSpec | null;
  onChange: (spec: ScheduleSpec) => void;
  timezone?: string;
}) {
  const [mode, setMode] = useState<ScheduleMode>(() => detectMode(value));
  const [minutes, setMinutes] = useState(() =>
    value?.type === "interval" && value.intervalMs ? value.intervalMs / 60_000 : 30,
  );
  const [time, setTime] = useState(() => parseTime(value));
  const [dow, setDow] = useState(() => parseDow(value));
  const [cronExpr, setCronExpr] = useState(() => value?.expression ?? "");

  function emit(m: ScheduleMode, mins: number, t: string, d: string, cron: string) {
    if (m === "interval") {
      onChange({ type: "interval", intervalMs: Math.max(1, mins) * 60_000 });
    } else if (m === "daily") {
      const [h, min] = t.split(":").map(Number);
      onChange({ type: "cron", expression: `${min} ${h} * * *`, timezone });
    } else if (m === "weekly") {
      const [h, min] = t.split(":").map(Number);
      onChange({ type: "cron", expression: `${min} ${h} * * ${d}`, timezone });
    } else {
      onChange({ type: "cron", expression: cron, timezone });
    }
  }

  function handleMode(m: ScheduleMode) {
    setMode(m);
    emit(m, minutes, time, dow, cronExpr);
  }

  const radioStyle = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 0",
    fontSize: 13,
    cursor: "pointer",
  } as const;

  const inputStyle = {
    padding: "4px 8px",
    border: "1px solid var(--color-border, #e5e5e5)",
    borderRadius: 4,
    fontSize: 13,
    background: "var(--color-bg-surface, #fff)",
    color: "var(--color-text-primary, #171717)",
  } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {/* Every N minutes */}
      <label style={radioStyle}>
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
          style={{ ...inputStyle, width: 56 }}
        />
        <span>minutes</span>
      </label>

      {/* Daily at time */}
      <label style={radioStyle}>
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
          style={{ ...inputStyle, width: 100 }}
        />
      </label>

      {/* Weekly on day at time */}
      <label style={radioStyle}>
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
          style={{ ...inputStyle, width: "auto" }}
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
          style={{ ...inputStyle, width: 100 }}
        />
      </label>

      {/* Custom cron */}
      <label style={radioStyle}>
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
          style={{ ...inputStyle, width: 120 }}
        />
      </label>
    </div>
  );
}
