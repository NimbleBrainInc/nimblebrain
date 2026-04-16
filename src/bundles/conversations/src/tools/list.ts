/**
 * Handler for conversations__list tool.
 *
 * List conversations with pagination, sorting, and filtering.
 * Delegates to ConversationIndex.list() which handles pagination, sorting,
 * date filtering, and search.
 */

import type { ConversationIndex, ListResult } from "../index-cache.ts";

export interface ListInput {
  limit?: number;
  cursor?: string;
  search?: string;
  sortBy?: "created" | "updated";
  dateFrom?: string;
  dateTo?: string;
}

export async function handleList(input: ListInput, index: ConversationIndex): Promise<ListResult> {
  return index.list({
    limit: input.limit,
    cursor: input.cursor,
    search: input.search,
    sortBy: input.sortBy,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
  });
}
