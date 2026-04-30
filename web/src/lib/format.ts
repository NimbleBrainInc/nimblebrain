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
