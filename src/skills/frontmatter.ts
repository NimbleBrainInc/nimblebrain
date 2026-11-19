/**
 * The one door to gray-matter. Every skill document — authored, on disk, or
 * fetched from a connector — is parsed here, and only as YAML.
 *
 * gray-matter picks its parser from the language named after the opening fence
 * (`---<lang>`), and the `language` option does not override that choice. Its
 * built-in non-YAML engines evaluate the block as code, so they are replaced
 * with ones that refuse: a document from any source parses as data or throws.
 * A language with no registered engine already throws inside gray-matter.
 *
 * Biome's `noRestrictedImports` keeps every other module off `gray-matter`.
 */

import matter from "gray-matter";

export type FrontmatterFile = matter.GrayMatterFile<string>;

function refuseNonYaml(): never {
  throw new Error("Frontmatter must be YAML");
}

const YAML_ONLY = {
  language: "yaml",
  engines: {
    javascript: refuseNonYaml,
    coffee: refuseNonYaml,
  },
};

/** Parse a document's YAML frontmatter and body. Throws on a non-YAML fence or malformed YAML. */
export function parseFrontmatter(text: string): FrontmatterFile {
  return matter(text, YAML_ONLY);
}

/** Serialize `data` as YAML frontmatter above `body`. */
export function stringifyFrontmatter(body: string, data: object): string {
  return matter.stringify(body, data);
}
