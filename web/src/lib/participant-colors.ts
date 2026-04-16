/**
 * Deterministic participant colors for multi-user conversations.
 * Maps a userId to a stable color from a curated palette.
 */

const PALETTE = [
  "#6366f1", // indigo
  "#0891b2", // cyan
  "#c026d3", // fuchsia
  "#ea580c", // orange
  "#16a34a", // green
  "#dc2626", // red
  "#7c3aed", // violet
  "#0284c7", // sky
];

/** DJB2 hash → palette index. Stable across sessions for the same userId. */
export function participantColor(userId: string): string {
  let hash = 5381;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) + hash + userId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}
