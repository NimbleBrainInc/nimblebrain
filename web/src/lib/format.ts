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
