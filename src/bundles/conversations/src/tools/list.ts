/**
 * Handler for conversations__list tool.
 *
 * List conversations with pagination, sorting, and filtering, walled to one
 * workspace. The workspace arrives as `scope` — a separate parameter from
 * `input` — because it is the request's focused workspace, not something the
 * caller names. Delegates to ConversationIndex.list() which handles pagination,
 * sorting, date filtering, and search.
 */

import type {
  AccessContext,
  ConversationIndex,
  ListResult,
  WorkspaceScope,
} from "../index-cache.ts";

export interface ListInput {
  limit?: number;
  cursor?: string;
  search?: string;
  sortBy?: "created" | "updated";
  dateFrom?: string;
  dateTo?: string;
}

export async function handleList(
  input: ListInput,
  index: ConversationIndex,
  scope: WorkspaceScope,
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
      workspaceId: scope.workspaceId,
      includeUnstamped: scope.includeUnstamped,
    },
    access,
  );
}
