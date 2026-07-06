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

/** Per-term token signal: +20 for a name-token hit, +10 for a description-token hit, plus coverage. */
function scoreQueryTerms(
  nameTokens: Set<string>,
  descriptionTokens: Set<string>,
  queryTerms: string[],
): { score: number; matchedTerms: number } {
  let score = 0;
  let matchedTerms = 0;
  for (const term of queryTerms) {
    const nameMatch = hasTerm(nameTokens, term);
    const descriptionMatch = hasTerm(descriptionTokens, term);
    if (!nameMatch && !descriptionMatch) continue;

    matchedTerms++;
    score += nameMatch ? 20 : 0;
    score += descriptionMatch ? 10 : 0;
  }
  return { score, matchedTerms };
}

/** Score one tool against the query; null when neither a substring nor a term matches. */
function scoreTool<T extends ToolSearchResult>(
  tool: T,
  normalizedQuery: string,
  queryTerms: string[],
): ScoredTool<T> | null {
  const nameSubstringMatch = tool.name.toLowerCase().includes(normalizedQuery);
  const descriptionSubstringMatch = tool.description.toLowerCase().includes(normalizedQuery);
  const termSignal = scoreQueryTerms(tokenSet(tool.name), tokenSet(tool.description), queryTerms);

  if (termSignal.matchedTerms === 0 && !nameSubstringMatch && !descriptionSubstringMatch) {
    return null;
  }

  // `score` carries only the substring + per-term signal. Query-term *coverage*
  // (`matchedTerms`) is the comparator's primary sort key, so it is deliberately
  // not folded into `score` too — within any matchedTerms tie-group the coverage
  // contribution is constant and cancels, so encoding it here would never change
  // ordering.
  const score =
    (nameSubstringMatch ? 200 : 0) + (descriptionSubstringMatch ? 100 : 0) + termSignal.score;
  return { tool, score, matchedTerms: termSignal.matchedTerms };
}

/** Rank order: term coverage first, then accumulated score, then tie-broken by name. */
function compareScored<T extends ToolSearchResult>(a: ScoredTool<T>, b: ScoredTool<T>): number {
  if (b.matchedTerms !== a.matchedTerms) return b.matchedTerms - a.matchedTerms;
  if (b.score !== a.score) return b.score - a.score;
  return a.tool.name.localeCompare(b.tool.name);
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
    const result = scoreTool(tool, normalizedQuery, queryTerms);
    if (result) scored.push(result);
  }

  scored.sort(compareScored);
  return scored.map((s) => s.tool);
}
