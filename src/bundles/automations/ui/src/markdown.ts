import DOMPurify from "dompurify";
import { marked } from "marked";

// GitHub-flavored markdown, no auto-mangling of header IDs.
marked.setOptions({ gfm: true, breaks: false });

// Render an automation run's text output to sanitized HTML. The text is
// produced by an LLM and may include third-party content fetched by tools,
// so we sanitize before injecting via dangerouslySetInnerHTML.
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
  });
}
