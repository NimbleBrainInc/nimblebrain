/**
 * The Skills editor's fields, for a skill that already exists, and the
 * `skills__update` arguments each one sends, as pure data logic.
 *
 * Free of React and of the API client so a server-side test can feed the exact
 * object the editor sends to `skills__update` (see `model-config-patch.ts`).
 *
 * One source of truth per field. The manifest fields (strategy, priority, tool
 * patterns, triggers) are each saved alone, as a manifest patch. The body is
 * saved alone too, as prose: its save always sends `frontmatter: "ignore"`, so
 * the server never reads a header out of it. A header the server applied would
 * overwrite whichever manifest fields it declares, including one the reader
 * saved a moment earlier, so on an existing skill a body that opens with a
 * `---` block is refused unless the reader keeps it as text. Creating a skill
 * is the one place a pasted header configures it.
 */

import type { SkillsUpdateInput } from "../../_generated/platform-schemas/skills";

export type LoadingStrategy = "always" | "dynamic";

/**
 * What each field holds while it is edited. Every value is the control's text,
 * so a half-typed priority is never coerced and the lists keep the blank lines
 * the reader typed until the save parses them.
 */
export interface SkillEditValues {
  body: string;
  loadingStrategy: LoadingStrategy;
  priority: string;
  toolAffinity: string;
  triggers: string;
}

export type SkillEditField = keyof SkillEditValues;

/** The priority band a skill may be authored into; 0–10 is reserved for core skills. */
export const MIN_PRIORITY = 11;
export const MAX_PRIORITY = 99;

/** One item per non-empty line — the shape a list field round-trips through. */
export function parseLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A list field's lines, or `null` (clear) when it has none. */
function listOrClear(value: string): string[] | null {
  const lines = parseLines(value);
  return lines.length > 0 ? lines : null;
}

/**
 * Does this body look like it opens a document header?
 *
 * A hint, not a contract: the server owns the real rule (a CLOSED fence whose
 * YAML yields keys). It is deliberately the looser test, so anything the server
 * would read as a header is caught here first. Tested against the trimmed
 * body, which is what a save sends, and tolerating trailing space on the fence
 * line, which the server's own line check does.
 */
export function looksLikeFrontmatter(body: string): boolean {
  return /^---[ \t]*\r?\n/.test(body.trim());
}

type ToolManifest = NonNullable<SkillsUpdateInput["manifest"]>;

/**
 * The arguments `skills__update` takes from this editor: a narrowing of the
 * tool's own input type. `manifest` picks its fields from the tool's, so a
 * field the tool stops accepting, or one whose type changes, fails to compile.
 */
export interface SkillUpdateArgs extends SkillsUpdateInput {
  id: string;
  // A strategy or priority save always carries a value; the editor never clears either.
  manifest?: Pick<ToolManifest, "loadingStrategy" | "priority" | "toolAffinity" | "triggers"> & {
    loadingStrategy?: LoadingStrategy;
    priority?: number;
  };
  body?: string;
  body_mode?: "replace";
  frontmatter?: "ignore";
}

/**
 * The `skills__update` arguments for one field of skill `id`.
 *
 * One field per save, so a save never touches a field the reader did not
 * change. A list left with no lines sends `null`, which clears it: a skill
 * stores no empty list, so "none" and "unset" are one state. Throws, with the
 * message the field shows, for a value the form must not send.
 */
export function skillEditPatch<K extends SkillEditField>(
  id: string,
  field: K,
  value: SkillEditValues[K],
  options: { keepHeaderAsText?: boolean } = {},
): SkillUpdateArgs {
  switch (field) {
    case "body": {
      const body = value.trim();
      if (!body) throw new Error("A skill needs a body.");
      if (looksLikeFrontmatter(body) && !options.keepHeaderAsText) {
        throw new Error(
          "This starts with a --- header. On an existing skill the fields below configure it, " +
            "so remove the header, or keep it as body text.",
        );
      }
      // `replace`: the textarea holds the whole body. `ignore`: the body is
      // prose, never a header that would override the fields.
      return { id, body, body_mode: "replace", frontmatter: "ignore" };
    }
    case "loadingStrategy":
      return { id, manifest: { loadingStrategy: value as LoadingStrategy } };
    case "priority": {
      const text = value.trim();
      const priority = Number(text);
      if (!/^\d+$/.test(text) || priority < MIN_PRIORITY || priority > MAX_PRIORITY) {
        throw new Error(`Priority is a whole number from ${MIN_PRIORITY} to ${MAX_PRIORITY}.`);
      }
      return { id, manifest: { priority } };
    }
    case "toolAffinity":
      return { id, manifest: { toolAffinity: listOrClear(value) } };
    case "triggers":
      return { id, manifest: { triggers: listOrClear(value) } };
  }
  throw new Error(`Unknown skill field: ${String(field)}`);
}
