/**
 * The one door to gray-matter. Every skill document — authored, on disk, or
 * fetched from a connector — is parsed here, and only as YAML.
 *
 * gray-matter picks its parser from the language named after the opening fence
 * (`---<lang>`), and the `language` option does not override that choice. So
 * every engine gray-matter registers except YAML is replaced with one that
 * refuses, and a language with no registered engine already throws inside
 * gray-matter. An empty block skips the engine, so the fence's language is
 * checked after parsing as well: a document from any source parses as YAML or
 * throws.
 *
 * The Biome plugin `biome-plugins/gray-matter-door.grit` keeps every other
 * module off `gray-matter`.
 */

import matter from "gray-matter";

export type FrontmatterFile = matter.GrayMatterFile<string>;

const YAML_NAMES = new Set(["yaml", "yml"]);

function refuseNonYaml(): never {
  throw new Error("Frontmatter must be YAML");
}

/** gray-matter's registered engines; its type declarations omit this export. */
const BUILT_IN_ENGINES = (matter as { engines?: Record<string, unknown> }).engines ?? {};

const YAML_ONLY = {
  language: "yaml",
  engines: Object.fromEntries(
    Object.keys(BUILT_IN_ENGINES)
      .filter((name) => name !== "yaml")
      .map((name) => [name, refuseNonYaml]),
  ),
};

/** Parse a document's YAML frontmatter and body. Throws on a non-YAML fence or malformed YAML. */
export function parseFrontmatter(text: string): FrontmatterFile {
  const file = matter(text, YAML_ONLY);
  if (!YAML_NAMES.has(file.language.toLowerCase())) refuseNonYaml();
  return file;
}

/** Serialize `data` as YAML frontmatter above `body`. */
export function stringifyFrontmatter(body: string, data: object): string {
  return matter.stringify(body, data, YAML_ONLY);
}
