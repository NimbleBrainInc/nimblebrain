import DOMPurify from "dompurify";
import { marked } from "marked";

// GitHub-flavored markdown, no auto-mangling of header IDs.
marked.setOptions({ gfm: true, breaks: false });

/**
 * Tags allowed in rendered automation output. Default-deny: anything
 * NOT on this list is stripped. Covers what `marked` actually emits for
 * standard markdown (headings, paragraphs, lists, links, code, tables,
 * emphasis, hr) and leaves out everything else (script/iframe/object/
 * embed/form/etc.) by definition.
 *
 * Allowlist beats forbiddenlist for this use case — `FORBID_TAGS` over
 * the `html` profile was inconsistent in practice (some void elements
 * like `<embed>` slipped through in certain HTML-parsing contexts).
 */
const ALLOWED_TAGS = [
  // structure
  "p",
  "br",
  "hr",
  "div",
  "span",
  // headings
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  // text
  "strong",
  "em",
  "del",
  "s",
  "blockquote",
  "code",
  "pre",
  // lists
  "ul",
  "ol",
  "li",
  // links
  "a",
  // tables
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
];

/** Attributes allowed on any tag. `href` is needed for links; everything
 *  else is suppressed — no `style` (XSS via CSS expressions on old
 *  engines), no `on*` event handlers, no `srcset`, no `data-*`. */
const ALLOWED_ATTR = ["href", "title", "align"];

/**
 * Render an automation run's text output to sanitized HTML. The text is
 * produced by an LLM and may include third-party content fetched by
 * tools, so we sanitize before injecting via `dangerouslySetInnerHTML`.
 *
 * DOMPurify is configured with explicit `ALLOWED_TAGS` / `ALLOWED_ATTR`
 * lists and `KEEP_CONTENT: true` so disallowed tags are removed but
 * their text children survive (a stripped `<object>` doesn't blank its
 * inner text).
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    KEEP_CONTENT: true,
    // `data:` would let an LLM smuggle inline payloads; `javascript:`
    // and `vbscript:` are the classic XSS vectors. DOMPurify defaults
    // already restrict these, but pin the contract explicitly.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/[^/])/i,
  });
}
