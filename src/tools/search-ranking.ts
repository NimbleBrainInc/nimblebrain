import type { ToolSchema } from "../engine/types.ts";

export type ToolSearchResult = Pick<ToolSchema, "name" | "description">;

interface ScoredTool<T extends ToolSearchResult> {
  tool: T;
  score: number;
  matchedTerms: number;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function tokenVariants(token: string): string[] {
  if (token.length > 3 && token.endsWith("s")) return [token, token.slice(0, -1)];
  return [token];
}

function tokenSet(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of tokenize(value)) {
    for (const variant of tokenVariants(token)) tokens.add(variant);
  }
  return tokens;
}

function hasTerm(tokens: Set<string>, term: string): boolean {
  for (const variant of tokenVariants(term)) {
    if (tokens.has(variant)) return true;
  }
  return false;
}

/**
 * Rank installed tools for natural-language discovery queries.
 *
 * Matching is deterministic and dependency-free: full-query substring matches
 * still work, but multi-term queries also match tokenized source names, tool
 * names, and descriptions. Full query-term coverage ranks above partial hits.
 */
export function rankToolSearchResults<T extends ToolSearchResult>(tools: T[], query: string): T[] {
  const normalizedQuery = query.toLowerCase().trim();
  const queryTerms = [...new Set(tokenize(normalizedQuery))];
  if (queryTerms.length === 0) return tools;

  const scored: ScoredTool<T>[] = [];
  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    const nameTokens = tokenSet(tool.name);
    const descriptionTokens = tokenSet(tool.description);

    let score = 0;
    if (name.includes(normalizedQuery)) score += 200;
    if (description.includes(normalizedQuery)) score += 100;

    let matchedTerms = 0;
    for (const term of queryTerms) {
      const nameMatch = hasTerm(nameTokens, term);
      const descriptionMatch = hasTerm(descriptionTokens, term);
      if (!nameMatch && !descriptionMatch) continue;

      matchedTerms++;
      score += nameMatch ? 20 : 0;
      score += descriptionMatch ? 10 : 0;
    }

    if (matchedTerms === 0) continue;
    const fullCoverage = matchedTerms === queryTerms.length;
    score += matchedTerms * 1000;
    if (fullCoverage) score += 500;

    scored.push({ tool, score, matchedTerms });
  }

  scored.sort((a, b) => {
    if (b.matchedTerms !== a.matchedTerms) return b.matchedTerms - a.matchedTerms;
    if (b.score !== a.score) return b.score - a.score;
    return a.tool.name.localeCompare(b.tool.name);
  });

  return scored.map((s) => s.tool);
}
