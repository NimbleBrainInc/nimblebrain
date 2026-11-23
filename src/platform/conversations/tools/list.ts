/**
 * Handler for conversations__list tool.
 *
 * List conversations with pagination, sorting, and filtering, walled to one
 * workspace and one owner. Both arrive as `scope` — a separate parameter from
 * `input` — because they are the request's workspace and identity, not
 * something the caller names. Delegates to ConversationIndex.list() which handles pagination,
 * sorting, date filtering, and search.
 *
 * Each row drops the index's `filePath`: it is a server filesystem path, which
 * the model and MCP clients have no use for and should not see. Readers address
 * a conversation by `id`.
 */

import type { ConversationsListInput } from "../../schemas/conversations.ts";
import type { ConversationIndex, IndexEntry, ListResult, ReadScope } from "../index-cache.ts";

/** One `conversations__list` row: an index entry without its server path. */
export type ListedConversation = Omit<IndexEntry, "filePath">;

export interface ListPage extends Omit<ListResult, "conversations"> {
  conversations: ListedConversation[];
}

export async function handleList(
  input: ConversationsListInput,
  index: ConversationIndex,
  scope: ReadScope,
): Promise<ListPage> {
  const result = index.list(scope, {
    limit: input.limit,
    cursor: input.cursor,
    search: input.search,
    sortBy: input.sortBy,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
  });
  return {
    ...result,
    conversations: result.conversations.map(({ filePath: _filePath, ...entry }) => entry),
  };
}
