// ---------------------------------------------------------------------------
// workspace-avatar — deterministic letter+color avatar for a workspace
//
// Stub. Workspaces don't carry a user-customizable avatar yet; for now we
// derive a stable visual identity from the workspace id (color) and name
// (letter). When the schema gains an optional `avatar` override, callers
// should prefer it and fall back to this computation when absent.
//
// Determinism is the point: the same workspace id always picks the same
// color across reloads / devices / sessions, so the sidebar's visual
// hierarchy is consistent without per-user state.
// ---------------------------------------------------------------------------
import type { WorkspaceInfo } from "../context/WorkspaceContext";

export interface WorkspaceAvatar {
  /** Single uppercase letter — first letter of the workspace name. */
  letter: string;
  /** Hex color string (#RRGGBB). One of a curated palette. */
  color: string;
}

/**
 * Curated palette of background colors. Tuned for ~AAA contrast against
 * white foreground letters (each entry is dark enough for white text to
 * read clearly). Order is arbitrary; the hash selects deterministically.
 */
const PALETTE: readonly string[] = [
  "#1f2937", // slate-800
  "#dc2626", // red-600
  "#ea580c", // orange-600
  "#ca8a04", // yellow-600
  "#16a34a", // green-600
  "#0891b2", // cyan-600
  "#2563eb", // blue-600
  "#7c3aed", // violet-600
  "#c026d3", // fuchsia-600
  "#db2777", // pink-600
];

export function getWorkspaceAvatar(workspace: WorkspaceInfo): WorkspaceAvatar {
  const letter = (workspace.name?.trim()?.[0] ?? "?").toUpperCase();
  const color = pickColor(workspace.id);
  return { letter, color };
}

function pickColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    // djb2-style hash; intentionally simple — collisions are visual, not
    // load-bearing.
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PALETTE.length;
  // biome-ignore lint/style/noNonNullAssertion: idx is `% PALETTE.length`, so always in-range
  return PALETTE[idx]!;
}
