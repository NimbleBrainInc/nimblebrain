import type { App } from "@nimblebrain/synapse";
import type { ConversationSummary, ListResult } from "./types";

/** Conversations one `list` call asks for. */
export const PAGE_SIZE = 50;

/** What the screen holds of the list: the rows read so far and where the next page starts. */
export interface Loaded {
  conversations: ConversationSummary[];
  nextCursor: string | null;
  totalCount: number;
  /** Pages read, so a refresh reads as many again. */
  pages: number;
}

/** One `list` page; rejects with the tool's error. */
async function listPage(app: App, cursor: string | null): Promise<ListResult> {
  const res = await app.callTool<ListResult>("list", {
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  });
  if (res.isError) throw new Error("Failed to load conversations");
  return res.data;
}

/** Rows of `more` not already in `rows`, after them: a row that moved between pages shows once. */
function merge(rows: ConversationSummary[], more: ConversationSummary[]): ConversationSummary[] {
  const seen = new Set(rows.map((r) => r.id));
  return [...rows, ...more.filter((r) => !seen.has(r.id))];
}

/** The first `pages` pages (at least one), following each page's cursor. */
export async function readPages(app: App, pages: number): Promise<Loaded> {
  let loaded: Loaded = { conversations: [], nextCursor: null, totalCount: 0, pages: 0 };
  do {
    loaded = await readNext(app, loaded);
  } while (loaded.pages < pages && loaded.nextCursor);
  return loaded;
}

/** `loaded` with the page after it appended. */
export async function readNext(app: App, loaded: Loaded): Promise<Loaded> {
  const page = await listPage(app, loaded.pages === 0 ? null : loaded.nextCursor);
  return {
    conversations: merge(loaded.conversations, page.conversations ?? []),
    nextCursor: page.nextCursor ?? null,
    totalCount: page.totalCount,
    pages: loaded.pages + 1,
  };
}
