// ---------------------------------------------------------------------------
// Command palette — fuzzy matcher (pure, no dependencies)
//
// Case-insensitive subsequence match scored by contiguity, start-of-word
// boundaries, and prefix. Good enough to rank a few dozen workspaces / apps /
// actions; not a general-purpose search engine. Kept pure so ranking is
// unit-testable without React.
// ---------------------------------------------------------------------------

export interface MatchResult {
  matched: boolean;
  /** Higher is better. -Infinity when the query is not a subsequence. */
  score: number;
}

const NO_MATCH: MatchResult = { matched: false, score: Number.NEGATIVE_INFINITY };

function isWordChar(ch: string): boolean {
  return /[a-z0-9]/.test(ch);
}

/**
 * Score `query` against `text`. Empty query matches everything (score 0) so an
 * unfiltered palette shows every item. Bonuses: +3 when a matched char begins a
 * word (start, or after a non-word char), +2 for each consecutive matched char,
 * +5 for a full prefix match, and a small shortness bonus so "CRM" outranks
 * "CRM Archive" for the query "crm".
 */
export function fuzzyScore(query: string, text: string): MatchResult {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (q.length === 0) return { matched: true, score: 0 };
  if (q.length > t.length) return NO_MATCH;

  let score = 0;
  let qi = 0;
  let prevMatchIdx = -2; // so the first match never counts as "consecutive"

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;

    let pts = 1;
    const isBoundary = ti === 0 || !isWordChar(t[ti - 1]!);
    if (isBoundary) pts += 3;
    if (ti === prevMatchIdx + 1) pts += 2;

    score += pts;
    prevMatchIdx = ti;
    qi++;
  }

  if (qi < q.length) return NO_MATCH;

  if (t.startsWith(q)) score += 5;
  // Prefer shorter haystacks for the same match (caps the bonus so a long
  // title with a great match still beats a short title with a poor one).
  score += Math.max(0, 5 - (t.length - q.length) * 0.1);

  return { matched: true, score };
}

/**
 * Best score for an item across its title and keywords. Keyword matches are
 * docked 2 points so a title hit always wins a tie. Returns the title result
 * (possibly NO_MATCH) when nothing matches.
 */
export function scoreItem(
  query: string,
  fields: { title: string; keywords?: string[] },
): MatchResult {
  let best = fuzzyScore(query, fields.title);
  for (const kw of fields.keywords ?? []) {
    const r = fuzzyScore(query, kw);
    if (r.matched) {
      const docked = r.score - 2;
      if (!best.matched || docked > best.score) {
        best = { matched: true, score: docked };
      }
    }
  }
  return best;
}
