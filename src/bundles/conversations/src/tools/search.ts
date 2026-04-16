/**
 * Handler for conversations__search tool.
 *
 * Grep-style search: read each JSONL file as raw text, find matches,
 * extract snippets. No message parsing needed — just string search.
 */

import { readFile } from "node:fs/promises";
import type { ConversationIndex } from "../index-cache.ts";

export interface SearchInput {
  query: string;
  limit?: number;
}

interface MatchSnippet {
  snippet: string;
}

interface SearchResult {
  id: string;
  title: string | null;
  matches: MatchSnippet[];
}

const SNIPPET_CONTEXT = 100;
const MAX_SNIPPETS_PER_CONVERSATION = 3;
const DEFAULT_LIMIT = 10;

function extractSnippet(text: string, matchStart: number, queryLength: number): string {
  const start = Math.max(0, matchStart - SNIPPET_CONTEXT);
  const end = Math.min(text.length, matchStart + queryLength + SNIPPET_CONTEXT);

  let snippet = text.slice(start, end);

  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;

  return snippet;
}

export async function handleSearch(input: SearchInput, index: ConversationIndex): Promise<object> {
  const query = input.query?.trim();
  if (!query) {
    throw new Error("query is required and cannot be empty");
  }

  const limit = input.limit ?? DEFAULT_LIMIT;
  const queryLower = query.toLowerCase();

  const allConversations = index.list({ limit: index.size || 1 });
  const results: SearchResult[] = [];

  for (const entry of allConversations.conversations) {
    if (results.length >= limit) break;

    let raw: string;
    try {
      raw = await readFile(entry.filePath, "utf-8");
    } catch {
      continue;
    }

    const rawLower = raw.toLowerCase();
    if (!rawLower.includes(queryLower)) continue;

    // File contains the query — extract snippets from matching message lines
    // Skip line 0 (metadata), search message lines only
    const lines = raw.split("\n");
    const matches: MatchSnippet[] = [];

    for (let i = 1; i < lines.length && matches.length < MAX_SNIPPETS_PER_CONVERSATION; i++) {
      const line = lines[i]!;
      const lineLower = line.toLowerCase();
      if (!lineLower.includes(queryLower)) continue;

      // Extract plain text from the message JSON
      let text = line;
      try {
        const msg = JSON.parse(line) as { content?: unknown };
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((b: { type?: string; text?: string }) => b.type === "text" && b.text)
            .map((b: { text: string }) => b.text)
            .join(" ");
        }
      } catch {
        // Not valid JSON — search raw line
      }

      const textLower = text.toLowerCase();
      const pos = textLower.indexOf(queryLower);
      if (pos < 0) continue;

      matches.push({ snippet: extractSnippet(text, pos, query.length) });
    }

    if (matches.length > 0) {
      results.push({
        id: entry.id,
        title: entry.title,
        matches,
      });
    }
  }

  return {
    results,
    totalMatches: results.length,
  };
}
