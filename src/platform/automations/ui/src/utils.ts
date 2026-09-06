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

export function statusDotClass(
  status: string | null,
  enabled: boolean,
  consecutiveErrors?: number,
): string {
  if (!enabled) return "dot-disabled";
  if (consecutiveErrors && consecutiveErrors > 0) return "dot-backoff";
  if (!status) return "dot-disabled";
  const map: Record<string, string> = {
    success: "dot-success",
    failure: "dot-failure",
    timeout: "dot-timeout",
    running: "dot-running",
    skipped: "dot-skipped",
    cancelled: "dot-disabled",
  };
  return map[status] || "dot-disabled";
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
