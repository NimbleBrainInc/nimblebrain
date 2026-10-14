import { join } from "node:path";

/** Bun installs package binaries with an .exe suffix on native Windows. */
export function tscBinary(packageDir: string, platform = process.platform): string {
  return join(packageDir, "node_modules", ".bin", platform === "win32" ? "tsc.exe" : "tsc");
}

/** tsc --listFiles prints forward slashes even when node:path uses backslashes. */
export function normalizeTscPath(path: string, platform = process.platform): string {
  const normalized = path.trim().replaceAll("\\", "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Check positive --listFiles coverage; retain original paths for diagnostics. */
export function unlistedSources(
  sources: string[],
  tscLines: string[],
  platform = process.platform,
): string[] {
  const listed = new Set(tscLines.map((line) => normalizeTscPath(line, platform)));
  return sources.filter((source) => !listed.has(normalizeTscPath(source, platform)));
}
