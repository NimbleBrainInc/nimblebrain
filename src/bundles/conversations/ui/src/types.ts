export interface ConversationSummary {
  id: string;
  title?: string;
  preview?: string;
  createdAt?: string;
  updatedAt?: string;
  /**
   * The room (workspace) the conversation ran in. Absent on legacy chats
   * with no stamped room — read as the owner's personal room.
   */
  workspaceId?: string | null;
}

/**
 * Which room's chats the list shows. "current" scopes to the room the shell
 * is focused on (the default — a chat list that matches where you are);
 * "all" is the deliberate cross-room view.
 */
export type RoomScope = "current" | "all";

export interface ListResult {
  conversations: ConversationSummary[];
  totalCount: number;
  nextCursor?: string | null;
}

export interface SearchMatch {
  snippet: string;
}

export interface SearchResultItem {
  id: string;
  title?: string;
  matches?: SearchMatch[];
}

export interface SearchResultData {
  results: SearchResultItem[];
}

export type FilterKey = "all" | "today" | "yesterday" | "week" | "earlier";

export interface DateGroup {
  label: string;
  items: ConversationSummary[];
}
