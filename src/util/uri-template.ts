import { UriTemplate } from "@modelcontextprotocol/server";

/**
 * Matching a URI against a resource template a connector advertises. Templates and URIs are both
 * untrusted, and the SDK compiles a template to a regex, so the cost of a match is bounded here:
 * a template whose match could cost more than quadratic time matches nothing, and so does a URI
 * longer than `URI_TEMPLATE_MAX_URI_LENGTH`.
 */

/** Longest URI matched against a template; past it, quadratic work stops being cheap. */
export const URI_TEMPLATE_MAX_URI_LENGTH = 2048;

interface TemplateExpression {
  /** The characters this expression's compiled class cannot consume. */
  stops: string;
  /** The literal the compiled pattern puts before the expression's value. */
  prefix: string;
  start: number;
  end: number;
}

/** One expression as the SDK's `UriTemplate` compiles it to a regex. */
function templateExpression(body: string, start: number, end: number): TemplateExpression {
  const operator = "+#./;?&".includes(body[0] ?? "") ? (body[0] ?? "") : "";
  const exploded = body.includes("*");
  const first = body.slice(operator.length).split(",")[0]?.replace("*", "").trim() ?? "";
  switch (operator) {
    case "+":
    case "#":
      return { stops: "", prefix: "", start, end };
    case "?":
    case "&":
      return { stops: "&", prefix: `${operator}${first}=`, start, end };
    case ";":
      return { stops: "/", prefix: "", start, end };
    case ".":
      return { stops: "/,", prefix: ".", start, end };
    case "/":
      return { stops: exploded ? "/" : "/,", prefix: "/", start, end };
    default:
      return { stops: exploded ? "/" : "/,", prefix: "", start, end };
  }
}

/**
 * Whether a template's match can cost more than quadratic time. An expression's value ends at a
 * single place when the text after it (the literal, then the next expression's prefix) holds a
 * character the value cannot consume; the SDK compiles `{x}` to `([^/,]+)`, `{;x}` to `([^/]+)`,
 * `{?x}` to `\?x=([^&]+)` and `{+x}` / `{#x}` to `(.+)`. Each boundary where the value could end
 * in more than one place multiplies the work on a URI that does not match by its length, so a
 * template with more than one such boundary matches nothing. One is allowed, so `{id}{?cursor}`
 * and `{+path}` still match. The last expression ends where the URI does. Templates come from
 * connectors, so matching one must stay cheap.
 */
function isUnboundedTemplate(template: string): boolean {
  // One pass over the braces: a regex scan retries from every `{` that never closes.
  const expressions: TemplateExpression[] = [];
  for (let open = template.indexOf("{"); open !== -1; ) {
    const close = template.indexOf("}", open);
    if (close === -1) return true; // Unclosed: the SDK rejects it too.
    expressions.push(templateExpression(template.slice(open + 1, close), open, close + 1));
    open = template.indexOf("{", close);
  }
  let ambiguous = 0;
  for (let i = 0; i + 1 < expressions.length; i++) {
    const current = expressions[i];
    const next = expressions[i + 1];
    if (!current || !next) continue;
    const between = template.slice(current.end, next.start) + next.prefix;
    if (![...between].some((c) => current.stops.includes(c)) && ++ambiguous > 1) return true;
  }
  return false;
}

/** Most templates a process keeps parsed; past it the oldest is dropped. */
const TEMPLATE_CACHE_LIMIT = 512;

/** Each template string seen, parsed once; `null` for one that is refused or does not parse. */
const templateCache = new Map<string, UriTemplate | null>();

function compiled(template: string): UriTemplate | null {
  const cached = templateCache.get(template);
  if (cached !== undefined) return cached;
  let parsed: UriTemplate | null = null;
  if (!isUnboundedTemplate(template)) {
    try {
      parsed = new UriTemplate(template);
    } catch {
      parsed = null;
    }
  }
  if (templateCache.size >= TEMPLATE_CACHE_LIMIT) {
    const oldest = templateCache.keys().next().value;
    if (oldest !== undefined) templateCache.delete(oldest);
  }
  templateCache.set(template, parsed);
  return parsed;
}

/**
 * Whether `uri` is one of `template`'s expansions. A template that does not parse, or whose
 * match could backtrack without bound (`isUnboundedTemplate`), matches nothing, and so does a
 * URI longer than `URI_TEMPLATE_MAX_URI_LENGTH`.
 */
export function expandsFrom(template: string, uri: string): boolean {
  if (uri.length > URI_TEMPLATE_MAX_URI_LENGTH) return false;
  const parsed = compiled(template);
  if (parsed === null) return false;
  try {
    return parsed.match(uri) !== null;
  } catch {
    return false;
  }
}
