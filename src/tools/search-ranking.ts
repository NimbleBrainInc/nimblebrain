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

// Best-effort plural folding: a token longer than 3 chars ending in "s" also
// matches its singular ("boards" → "board"). Applied symmetrically to both
// query and corpus tokens, so an over-stripped junk variant ("status" →
// "statu") only matches if some other real token stems to the same string —
// which doesn't occur in the tool corpus. Intentionally naive; a real stemmer
// isn't worth a dependency for discovery ranking.
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
    const nameSubstringMatch = name.includes(normalizedQuery);
    const descriptionSubstringMatch = description.includes(normalizedQuery);
    const nameTokens = tokenSet(tool.name);
    const descriptionTokens = tokenSet(tool.description);

    let score = 0;
    if (nameSubstringMatch) score += 200;
    if (descriptionSubstringMatch) score += 100;

    let matchedTerms = 0;
    for (const term of queryTerms) {
      const nameMatch = hasTerm(nameTokens, term);
      const descriptionMatch = hasTerm(descriptionTokens, term);
      if (!nameMatch && !descriptionMatch) continue;

      matchedTerms++;
      score += nameMatch ? 20 : 0;
      score += descriptionMatch ? 10 : 0;
    }

    if (matchedTerms === 0 && !nameSubstringMatch && !descriptionSubstringMatch) continue;

    // `score` carries only the substring + per-term signal. Query-term
    // *coverage* is the comparator's primary sort key (below), so it is
    // deliberately not folded into `score` too — within any matchedTerms
    // tie-group the coverage contribution is constant and cancels, so
    // encoding it here would never change ordering.
    scored.push({ tool, score, matchedTerms });
  }

  scored.sort((a, b) => {
    if (b.matchedTerms !== a.matchedTerms) return b.matchedTerms - a.matchedTerms;
    if (b.score !== a.score) return b.score - a.score;
    return a.tool.name.localeCompare(b.tool.name);
  });

  return scored.map((s) => s.tool);
}
