import type { FileKind, FileSource } from "./types";

export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i >= units.length) i = units.length - 1;
  const val = bytes / 1024 ** i;
  return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "Just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function isImage(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.startsWith("image/"));
}

// Uppercase file extension for the thumbnail caption (e.g. "PDF", "XML").
// Returns "" when there's no usable extension. Capped at 4 chars so a
// stray dotted filename can't blow out the label.
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot >= filename.length - 1) return "";
  return filename
    .slice(dot + 1)
    .toUpperCase()
    .slice(0, 4);
}

/** The kind chips, in the order they show. */
export const KIND_FILTERS: Array<{ key: FileKind; label: string }> = [
  { key: "document", label: "Documents" },
  { key: "image", label: "Images" },
  { key: "data", label: "Data" },
  { key: "font", label: "Fonts" },
  { key: "other", label: "Other" },
];

/**
 * The source chips. "Uploaded" covers both upload sources, since the
 * difference between the host's picker and the API is not one a person picks by.
 */
export const SOURCE_FILTERS: Array<{ key: string; label: string; sources: FileSource[] }> = [
  { key: "chat", label: "From chats", sources: ["chat"] },
  { key: "agent", label: "Made by agents", sources: ["agent"] },
  { key: "upload", label: "Uploaded", sources: ["app", "manual"] },
];

/** How a file's source reads in the list and the detail panel. */
export function sourceLabel(source: FileSource | undefined): string {
  if (source === "chat") return "Chat";
  if (source === "agent") return "Agent";
  if (source === "app" || source === "manual") return "Upload";
  return "";
}

export type Since = "any" | "day" | "week" | "month";

export const SINCE_FILTERS: Array<{ key: Since; label: string; days: number }> = [
  { key: "day", label: "Today", days: 1 },
  { key: "week", label: "7 days", days: 7 },
  { key: "month", label: "30 days", days: 30 },
];

/** The `createdAfter` a date chip asks for, or `undefined` for any time. */
export function sinceToIso(since: Since, now = Date.now()): string | undefined {
  const preset = SINCE_FILTERS.find((s) => s.key === since);
  if (!preset) return undefined;
  return new Date(now - preset.days * 86_400_000).toISOString();
}
