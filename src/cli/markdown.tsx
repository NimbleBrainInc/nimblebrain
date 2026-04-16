import { Box, Text } from "ink";
import { createElement, Fragment } from "react";

/**
 * Lightweight markdown renderer for Ink.
 *
 * Handles the subset of markdown that LLMs commonly produce:
 * - **bold**, *italic*, `inline code`
 * - Code blocks (``` ... ```)
 * - Headings (# ## ###)
 * - Bullet lists (- or *)
 * - Numbered lists (1. 2. 3.)
 *
 * Not a full markdown parser — just enough for readable terminal output.
 */

interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  dimColor?: boolean;
}

/** Parse inline markdown (bold, italic, code) into styled segments. */
function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  // Match: `code`, **bold**, *italic* (in that priority order)
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    // Text before this match
    if (match.index! > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index!) });
    }

    if (match[1]) {
      // `code`
      segments.push({ text: match[1].slice(1, -1), code: true });
    } else if (match[2]) {
      // **bold**
      segments.push({ text: match[2].slice(2, -2), bold: true });
    } else if (match[3]) {
      // *italic*
      segments.push({ text: match[3].slice(1, -1), italic: true });
    }

    lastIndex = match.index! + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }

  return segments;
}

/** Render inline segments as Ink <Text> elements. */
function renderInline(segments: InlineSegment[], keyPrefix: string) {
  return segments.map((seg, i) => {
    if (seg.code) {
      return createElement(Text, { key: `${keyPrefix}-${i}`, dimColor: true }, seg.text);
    }
    return createElement(
      Text,
      { key: `${keyPrefix}-${i}`, bold: seg.bold, italic: seg.italic },
      seg.text,
    );
  });
}

/** Render a markdown string as Ink components. */
export function Markdown({ children }: { children: string }) {
  const lines = children.split("\n");
  const elements: React.ReactElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Code block
    if (line.trimStart().startsWith("```")) {
      const codeLines: string[] = [];
      const lang = line.trimStart().slice(3).trim();
      i++;
      while (i < lines.length && !lines[i]?.trimStart().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```

      elements.push(
        createElement(
          Box,
          {
            key: `block-${elements.length}`,
            flexDirection: "column",
            paddingLeft: 2,
            marginTop: lang ? 0 : 0,
          },
          lang ? createElement(Text, { dimColor: true, key: "lang" }, lang) : null,
          ...codeLines.map((cl, ci) =>
            createElement(Text, { dimColor: true, key: `code-${ci}` }, cl),
          ),
        ),
      );
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      elements.push(createElement(Text, { key: `blank-${elements.length}` }, " "));
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const content = headingMatch[2]!;
      elements.push(
        createElement(Text, { key: `h-${elements.length}`, bold: true, underline: true }, content),
      );
      i++;
      continue;
    }

    // Bullet list item (- or *)
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)/);
    if (bulletMatch) {
      const indent = Math.floor((bulletMatch[1]?.length ?? 0) / 2);
      const content = bulletMatch[2]!;
      const segments = parseInline(content);
      elements.push(
        createElement(
          Box,
          { key: `li-${elements.length}`, paddingLeft: indent * 2 },
          createElement(Text, null, "  ", ...renderInline(segments, `li-${elements.length}`)),
        ),
      );
      i++;
      continue;
    }

    // Numbered list item
    const numMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
    if (numMatch) {
      const indent = Math.floor((numMatch[1]?.length ?? 0) / 2);
      const num = line.match(/^(\s*)(\d+)\./)?.[2] ?? "1";
      const content = numMatch[2]!;
      const segments = parseInline(content);
      elements.push(
        createElement(
          Box,
          { key: `ol-${elements.length}`, paddingLeft: indent * 2 },
          createElement(Text, null, `${num}. `, ...renderInline(segments, `ol-${elements.length}`)),
        ),
      );
      i++;
      continue;
    }

    // Regular paragraph line
    const segments = parseInline(line);
    elements.push(
      createElement(
        Text,
        { key: `p-${elements.length}` },
        ...renderInline(segments, `p-${elements.length}`),
      ),
    );
    i++;
  }

  return createElement(Fragment, null, ...elements);
}
