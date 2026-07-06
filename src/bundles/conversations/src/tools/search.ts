/**
 * Handler for conversations__search tool.
 *
 * Grep-style search: read each JSONL file as raw text, find matches,
 * extract snippets. No message parsing needed — just string search.
 */

import { readFile } from "node:fs/promises";
import type { AccessContext, ConversationIndex } from "../index-cache.ts";

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

/** Read a file as UTF-8 text, returning null if it cannot be read. */
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Extract plain text from a message JSON line, falling back to the raw line if it is not valid JSON. */
function extractMessageText(line: string): string {
  try {
    const msg = JSON.parse(line) as { content?: unknown };
    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b: { type?: string; text?: string }) => b.type === "text" && b.text)
        .map((b: { text: string }) => b.text)
        .join(" ");
    }
  } catch {
    // Not valid JSON — search raw line
  }
  return line;
}

/** Scan a file's message lines (skipping the line-0 metadata) for the query and build up to MAX_SNIPPETS_PER_CONVERSATION snippets. */
function collectSnippets(raw: string, query: string, queryLower: string): MatchSnippet[] {
  // Skip line 0 (metadata), search message lines only
  const lines = raw.split("\n");
  const matches: MatchSnippet[] = [];

  for (let i = 1; i < lines.length && matches.length < MAX_SNIPPETS_PER_CONVERSATION; i++) {
    const line = lines[i]!;
    if (!line.toLowerCase().includes(queryLower)) continue;

    const text = extractMessageText(line);
    const pos = text.toLowerCase().indexOf(queryLower);
    if (pos < 0) continue;

    matches.push({ snippet: extractSnippet(text, pos, query.length) });
  }

  return matches;
}

export async function handleSearch(
  input: SearchInput,
  index: ConversationIndex,
  access?: AccessContext,
): Promise<object> {
  const query = input.query?.trim();
  if (!query) {
    throw new Error("query is required and cannot be empty");
  }

  const limit = input.limit ?? DEFAULT_LIMIT;
  const queryLower = query.toLowerCase();

  const allConversations = index.list({ limit: index.size || 1 }, access);
  const results: SearchResult[] = [];

  for (const entry of allConversations.conversations) {
    if (results.length >= limit) break;

    const raw = await readFileSafe(entry.filePath);
    if (raw === null) continue;
    if (!raw.toLowerCase().includes(queryLower)) continue;

    const matches = collectSnippets(raw, query, queryLower);
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
