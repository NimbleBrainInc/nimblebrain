export function parseToolResult(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "content" in (raw as Record<string, unknown>)) {
    const content = (raw as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const text = content.map((c: Record<string, unknown>) => c.text || "").join("");
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function asDict(raw: unknown): Record<string, unknown> {
  const parsed = parseToolResult(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = then - now;
  const abs = Math.abs(diff);
  if (abs < 60000) return diff >= 0 ? "in <1m" : "<1m ago";
  const mins = Math.floor(abs / 60000);
  if (mins < 60) return diff >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.floor(abs / 3600000);
  if (hours < 24) return diff >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(abs / 86400000);
  return diff >= 0 ? `in ${days}d` : `${days}d ago`;
}

export function formatDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt || !completedAt) return "-";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

export function formatTokens(n?: number): string {
  if (n === undefined || n === null) return "-";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** An error's message, or `fallback` for a thrown non-Error. */
export function errorText(err: unknown, fallback = "Something went wrong"): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * A tool error's message with the `{"error": …}` JSON envelope the tasks
 * source wraps it in taken off, so a person reads the sentence, not the JSON.
 */
export function toolErrorText(err: unknown, fallback?: string): string {
  const text = errorText(err, fallback);
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON: already a sentence
  }
  return text;
}

/** A pass rate as a whole percent, or an em dash when nothing was assessed. */
export function formatPercent(rate: number | null | undefined): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

/** USD with cents, "$0.00" for zero (unlike `formatCost`, which is blank for none). */
export function formatUsd(usd: number | null | undefined): string {
  if (usd == null || usd === 0) return "$0.00";
  return formatCost(usd);
}

/**
 * An instant as a reader scans a schedule: "Today 3:00 PM", "Tomorrow 7:20 AM",
 * a weekday within the week, else a date.
 */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOf = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((startOf(d.getTime()) - startOf(now)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) {
    return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}
