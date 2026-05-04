import type { ConversationSummary, DateGroup, FilterKey } from "./types";

export function relativeTime(iso: string | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "Just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function groupByDate(conversations: ConversationSummary[]): DateGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
  const startOfWeek = new Date(startOfToday.getTime() - 7 * 86400000);

  const groups: DateGroup[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This Week", items: [] },
    { label: "Earlier", items: [] },
  ];

  for (const c of conversations) {
    const d = new Date(c.updatedAt || c.createdAt || 0);
    if (d >= startOfToday) groups[0].items.push(c);
    else if (d >= startOfYesterday) groups[1].items.push(c);
    else if (d >= startOfWeek) groups[2].items.push(c);
    else groups[3].items.push(c);
  }

  return groups;
}

// Cumulative buckets: "week" includes today + yesterday + this-week.
export const FILTER_GROUPS: Record<FilterKey, number[]> = {
  all: [0, 1, 2, 3],
  today: [0],
  yesterday: [1],
  week: [0, 1, 2],
  earlier: [3],
};

export const FILTER_LABELS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This Week" },
  { key: "earlier", label: "Earlier" },
];
