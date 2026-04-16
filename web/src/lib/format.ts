/** Strip the MCP server prefix from a tool name (e.g. "server__tool" → "tool") */
export function stripServerPrefix(name: string): string {
  const idx = name.indexOf("__");
  return idx === -1 ? name : name.slice(idx + 2);
}

/** Format duration: <1000ms → "340ms", >=1000ms → "1.2s" */
export function formatDuration(ms: number): string {
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded}ms`;
  return `${(rounded / 1000).toFixed(1)}s`;
}
