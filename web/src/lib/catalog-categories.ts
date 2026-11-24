import type { CatalogListing } from "../api/client";

/**
 * A catalog's categories, read from its entries. A category is display text the
 * catalog states per entry; the shell holds no list of them, so a catalog with none
 * yields none and Browse shows no filter.
 */
export interface CategoryCount {
  name: string;
  count: number;
}

/** Each category the entries name, with how many name it, sorted by name. */
export function categoryCounts(entries: readonly CatalogListing[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.category) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether an entry passes Browse's search and category filter. The query is one
 * literal substring, matched case-insensitively across the name, description,
 * category and tags; a null category filters nothing.
 */
export function matchesListing(
  entry: CatalogListing,
  query: string,
  category: string | null,
): boolean {
  if (category !== null && entry.category !== category) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [entry.name, entry.description, entry.category ?? "", ...(entry.tags ?? [])].some((s) =>
    s.toLowerCase().includes(q),
  );
}
