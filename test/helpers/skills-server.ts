/**
 * Serve skills from a test MCP server the way the MCP Skills Extension
 * (SEP-2640) specifies: declare `io.modelcontextprotocol/skills` in the
 * server's capabilities and answer `skills/list` with an entry per skill —
 * its `SKILL.md` URI, its frontmatter verbatim, and its digest and size.
 *
 * The runtime discovers server-published skills only this way, so every
 * fixture that publishes a skill uses it. Bodies are still served by the
 * fixture's own `resources/read` handler.
 */

import { createHash } from "node:crypto";
import type { Server } from "@modelcontextprotocol/server";
import matter from "gray-matter";
import { z } from "zod";
import { SKILLS_EXTENSION_ID } from "../../src/skills/skills-extension.ts";

/** Spread into a fixture server's `capabilities` to declare the extension. */
export const SKILLS_EXTENSION_CAPABILITY = { extensions: { [SKILLS_EXTENSION_ID]: {} } };

const SkillsListParamsSchema = z.object({ cursor: z.string().optional() }).loose().optional();
const SkillsGetParamsSchema = z.object({ uri: z.string() }).loose();

/** A `skills/list` result: entries, and a cursor when more pages follow. */
export interface SkillsListResult {
  skills: unknown[];
  nextCursor?: string;
}

/** Answer `skills/list` with `handler`, for a fixture that shapes the listing itself. */
export function handleSkillsList(
  server: Server,
  handler: () => SkillsListResult | Promise<SkillsListResult>,
): void {
  server.setRequestHandler("skills/list", { params: SkillsListParamsSchema }, async () =>
    handler(),
  );
}

/** One manifest row: a file's URI, digest, and size. */
function fileRow(uri: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    uri,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.byteLength,
  };
}

/**
 * The `skills/list` entry a server lists for `text` served at `uri`. Any of
 * `files` (URI to text) under the skill's directory joins its manifest.
 */
export function skillEntryFor(uri: string, text: string, files: Record<string, string> = {}) {
  const root = `${uri.replace(/\/SKILL\.md$/, "")}/`;
  return {
    uri,
    frontmatter: JSON.parse(JSON.stringify(matter(text).data)) as Record<string, unknown>,
    resources: [
      fileRow(uri, text),
      ...Object.entries(files)
        .filter(([fileUri]) => fileUri.startsWith(root) && fileUri !== uri)
        .map(([fileUri, fileText]) => fileRow(fileUri, fileText)),
    ],
  };
}

/**
 * Answer `skills/list` and `skills/get` from `files` (URI to text), read on
 * each request so a test can change them. Every `…/SKILL.md` URI is a skill;
 * the other files are listed in the manifest of the skill whose directory
 * holds them. The server must also declare {@link SKILLS_EXTENSION_CAPABILITY}.
 */
export function serveSkills(server: Server, files: () => Record<string, string>): void {
  const entries = () => {
    const all = files();
    return Object.entries(all)
      .filter(([uri]) => uri.endsWith("/SKILL.md"))
      .map(([uri, text]) => skillEntryFor(uri, text, all));
  };
  handleSkillsList(server, () => ({ skills: entries() }));
  server.setRequestHandler("skills/get", { params: SkillsGetParamsSchema }, async (params) => {
    const skill = entries().find((entry) => entry.uri === params.uri);
    if (!skill) throw new Error(`Unknown skill: ${params.uri}`);
    return { skill };
  });
}
