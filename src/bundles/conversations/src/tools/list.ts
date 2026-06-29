/**
 * Handler for conversations__list tool.
 *
 * List conversations with pagination, sorting, and filtering.
 * Delegates to ConversationIndex.list() which handles pagination, sorting,
 * date filtering, and search.
 */

import type { AccessContext, ConversationIndex, ListResult } from "../index-cache.ts";

export interface ListInput {
  limit?: number;
  cursor?: string;
  search?: string;
  sortBy?: "created" | "updated";
  dateFrom?: string;
  dateTo?: string;
  /** Scope to one workspace. Applied before the limit so the page reflects the workspace's set. */
  workspaceId?: string;
  /** With `workspaceId`, also include workspaceless (legacy) chats — they belong to the personal workspace. */
  includeUnstamped?: boolean;
}

export async function handleList(
  input: ListInput,
  index: ConversationIndex,
  access?: AccessContext,
): Promise<ListResult> {
  return index.list(
    {
      limit: input.limit,
      cursor: input.cursor,
      search: input.search,
      sortBy: input.sortBy,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      workspaceId: input.workspaceId,
      includeUnstamped: input.includeUnstamped,
    },
    access,
  );
}
