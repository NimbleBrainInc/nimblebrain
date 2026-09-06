/**
 * The event-name glob a route matches on.
 *
 * Event names are the emitting server's own dotted strings and the runtime
 * never enumerates them, so a route needs a way to say "every domain event"
 * without the runtime knowing what a domain event is. The grammar is the
 * smallest one that expresses that:
 *
 * | Pattern | Means |
 * |---|---|
 * | `domain.active` | exactly that name |
 * | `domain.*` | one more segment: `domain.active`, not `domain.dns.ready` |
 * | `domain.**` | any remainder: `domain.active` AND `domain.dns.ready` |
 * | `**` | every name |
 *
 * `.` is the separator, `*` matches zero or more characters within one
 * segment, and `**` matches zero or more characters across any number of
 * them. Everything else is literal. A trailing `**` still requires the
 * separator before it — `domain.**` does not match the bare name `domain`,
 * because a route asking for what is under `domain` is not asking for
 * `domain` itself.
 *
 * Deliberately not a path matcher: that would bring `?`, `[a-z]`, brace
 * expansion and negation — four more things to document and to get wrong, for
 * a vocabulary that is dotted names.
 *
 * **And deliberately not a regex, including one this module builds itself.**
 * The stored pattern is not a regex and the schema's character class sees to
 * that, but compiling one *from* it puts the same expression on the same
 * background loop with the same absent timeout. A pattern alternating single
 * wildcards with literals — `*a*a*a*a*a`, ten characters, schema-legal — turns
 * into adjacent variable-length groups, and a long dot-free name that fails to
 * match walks every way of splitting it: measured at roughly 40x per added
 * wildcard, which reaches "never returns" inside the 200-character bound the
 * schema and the envelope parser already impose. That is synchronous CPU on
 * the shared event loop, so it stalls every workspace in the runtime and not
 * just the one whose route it is, it recurs on each poll, and it survives a
 * restart because the pattern is on the workspace record.
 *
 * So the match below is a **reachable-set sweep** and does no backtracking at
 * all: it walks the name once, carrying the set of token positions still live.
 * Cost is `name x tokens` — bounded at 200x200 — for every input, matching or
 * not. The property this file argues for in prose is now the one it implements.
 */

/**
 * One unit of a compiled pattern: a literal character, or a wildcard run.
 *
 * `crossesDot` is the whole of the difference between `*` and `**`, and a run
 * of three or more collapses to `**` — `***` can match nothing `**` cannot.
 */
interface GlobToken {
  /** The character to match, for a literal. Empty for a wildcard. */
  literal: string;
  /** `true` for `**`, `false` for `*`, `undefined` for a literal. */
  crossesDot?: boolean;
}

/**
 * Whether one event name matches one glob.
 *
 * An empty or absent pattern is "every name" — the schema makes `match.name`
 * optional and an omitted filter narrows nothing.
 */
export function matchesNameGlob(name: string, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern === "") return true;

  const tokens = tokenize(pattern);
  // `reachable[j]` — the pattern could have consumed everything read so far and
  // be sitting at token `j`. Length is `tokens.length + 1` so the last slot
  // means "the whole pattern is used up", which is the accepting position.
  let reachable = new Array<boolean>(tokens.length + 1).fill(false);
  reachable[0] = true;
  advancePastEmptyWildcards(tokens, reachable);

  for (const char of name) {
    reachable = step(tokens, reachable, char);
  }

  return reachable[tokens.length] === true;
}

/**
 * One character of the name: every live token consumes it, or does not.
 *
 * Both of a wildcard's choices are carried forward at once — stay and keep
 * eating, or hand over to the next token — which is what removes the need to
 * ever un-consume, and with it the backtracking.
 */
function step(
  tokens: readonly GlobToken[],
  reachable: readonly boolean[],
  char: string,
): boolean[] {
  const next = new Array<boolean>(tokens.length + 1).fill(false);
  for (let j = 0; j < tokens.length; j++) {
    if (!reachable[j]) continue;
    const token = tokens[j] as GlobToken;
    if (token.crossesDot === undefined) {
      // A literal consumes this character and moves on, or dies here.
      if (token.literal === char) next[j + 1] = true;
    } else if (token.crossesDot || char !== ".") {
      next[j] = true;
    }
  }
  advancePastEmptyWildcards(tokens, next);
  return next;
}

/**
 * Let every reachable wildcard also count as matching nothing.
 *
 * Ascending, and once: a wildcard's "skip me" edge only ever points one token
 * forward, so a single left-to-right sweep closes over a run of them.
 */
function advancePastEmptyWildcards(tokens: readonly GlobToken[], reachable: boolean[]): void {
  for (let j = 0; j < tokens.length; j++) {
    if (reachable[j] && tokens[j]?.crossesDot !== undefined) reachable[j + 1] = true;
  }
}

/** Split a pattern into literals and wildcard runs, left to right. */
function tokenize(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "*") {
      tokens.push({ literal: pattern[i] as string });
      continue;
    }
    let run = 0;
    while (pattern[i + run] === "*") run++;
    tokens.push({ literal: "", crossesDot: run >= 2 });
    i += run - 1;
  }
  return tokens;
}
