import type { FileEntry, FilterKey, TagCount } from "./types";

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

// Compose-once filter matchers. Used by the type-pill filter and the
// pill-count tally on each pill.
export const TYPE_FILTERS: Array<{
  key: FilterKey;
  label: string;
  match: (f: FileEntry) => boolean;
}> = [
  { key: "all", label: "All", match: () => true },
  { key: "images", label: "Images", match: (f) => isImage(f.mimeType) },
  {
    key: "documents",
    label: "Documents",
    match: (f) => {
      if (!f.mimeType) return false;
      return (
        f.mimeType === "application/pdf" ||
        f.mimeType.includes("document") ||
        f.mimeType.includes("docx") ||
        f.mimeType.includes("word") ||
        f.mimeType.includes("xlsx") ||
        f.mimeType.includes("spreadsheet") ||
        f.mimeType.startsWith("text/plain") ||
        f.mimeType.startsWith("text/markdown")
      );
    },
  },
  {
    key: "data",
    label: "Data",
    match: (f) => {
      if (!f.mimeType) return false;
      return (
        f.mimeType === "text/csv" || f.mimeType === "application/json" || f.mimeType.includes("xml")
      );
    },
  },
  { key: "fonts", label: "Fonts", match: (f) => Boolean(f.mimeType?.startsWith("font/")) },
];

export function collectTags(files: FileEntry[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    for (const t of f.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}
