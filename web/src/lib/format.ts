/** Format USD cost. Sub-penny → cents with ¢ symbol; otherwise 2 decimal places. */
export function formatUsd(n: number): string {
  if (n < 0.01 && n > 0) return `${(n * 100).toFixed(2)}¢`;
  return `$${n.toFixed(2)}`;
}

/** Format token count: >=1M → "2.5M", >=1K → "512K", else raw number. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * Format a UTC date-only string (YYYY-MM-DD) as short "M/D".
 * Input is always a UTC date key from the server — never local.
 */
export function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * Format a UTC date-only string (YYYY-MM-DD) for table display.
 * Input is always a UTC date key from the server — never local.
 */
export function formatDateLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { timeZone: "UTC" });
}

/** Strip the MCP server prefix from a tool name (e.g. "server__tool" → "tool") */
export function stripServerPrefix(name: string): string {
  const idx = name.indexOf("__");
  return idx === -1 ? name : name.slice(idx + 2);
}

/** Format duration: <0.5ms → "<1ms", <1000ms → "340ms", >=1000ms → "1.2s" */
export function formatDuration(ms: number): string {
  const rounded = Math.round(ms);
  if (rounded === 0 && ms > 0) return "<1ms";
  if (rounded < 1000) return `${rounded}ms`;
  return `${(rounded / 1000).toFixed(1)}s`;
}

/**
 * Format an instant for a list row: the time of day, with the date only as far
 * back as it needs to go. "Today 7:53 AM", "Yesterday 10:46 PM",
 * "Sep 30, 10:46 PM", and the year only outside the current one. Absolute, not
 * relative: "2 hours ago" hides the one thing an operator is checking. Seconds
 * are left to `formatInstantFull`.
 */
export function formatInstant(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfAt = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const daysAgo = Math.round((startOfToday.getTime() - startOfAt.getTime()) / 86_400_000);
  if (daysAgo === 0) return `Today ${time}`;
  if (daysAgo === 1) return `Yesterday ${time}`;
  const date = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}

/** The whole instant, to the second, for a hover or a detail view. */
export function formatInstantFull(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}
