export interface ConversationSummary {
  id: string;
  title?: string;
  preview?: string;
  createdAt?: string;
  updatedAt?: string;
  /**
   * The workspace the conversation ran in. Absent on legacy chats with no
   * stamped workspace — read as the owner's personal workspace.
   */
  workspaceId?: string | null;
}

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
