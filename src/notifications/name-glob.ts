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
 * Deliberately not a regex and deliberately not a path matcher. A regex in a
 * stored route is an expression the runtime evaluates on a background loop
 * with no timeout, which is a denial of service an admin can write by
 * accident; the schema's own character class already refuses one. A path
 * matcher would bring `?`, `[a-z]`, brace expansion and negation — four more
 * things to document and to get wrong, for a vocabulary that is dotted names.
 */

/** Characters that mean something to a regex and nothing to this grammar. */
const REGEX_META = /[.+?^${}()|[\]\\]/g;

/**
 * Whether one event name matches one glob.
 *
 * An empty or absent pattern is "every name" — the schema makes `match.name`
 * optional and an omitted filter narrows nothing.
 */
export function matchesNameGlob(name: string, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern === "") return true;
  return globRegex(pattern).test(name);
}

/**
 * Compiled fresh on every call rather than memoised. The pattern comes off a
 * workspace record, so a cache keyed by it grows with every route an admin
 * ever saved for the life of the process — an unbounded map to save a
 * compilation that costs microseconds a few times per notification.
 */
function globRegex(pattern: string): RegExp {
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char !== "*") {
      body += char.replace(REGEX_META, "\\$&");
      continue;
    }
    if (pattern[i + 1] === "*") {
      // Consume the whole run: `***` is `**`, not `**` followed by a segment
      // wildcard that could never match anything the first one left behind.
      while (pattern[i + 1] === "*") i++;
      body += ".*";
      continue;
    }
    body += "[^.]*";
  }

  return new RegExp(`^${body}$`);
}
