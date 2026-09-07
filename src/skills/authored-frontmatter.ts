/**
 * Recognise a pasted `SKILL.md` in a skill's `body`.
 *
 * The canonical artifact of the skill ecosystem is a whole file: YAML
 * frontmatter above a markdown body. It is what the vendored `authoring-guide`
 * tells agents to write, what the CLI reads, and what people copy between
 * repos. `skills__create` / `skills__update` take the two halves separately, so
 * a caller handing over a whole file used to have its frontmatter stored as
 * *prose* — inert YAML injected into the prompt on every turn, with the
 * manifest silently taking the caller's defaults instead of the values the
 * document stated.
 *
 * An editor (or a tool) may narrow what it can author. It may not silently
 * discard what it was handed. So the write path parses that block with the
 * runtime's own parser and schema — no second reader, no second contract — and
 * reports what it applied.
 *
 * What is NOT absorbed, and why:
 *   - `name` — the caller addresses the file by name; the permission gate and
 *     the existence check already ran against that path. A document renaming
 *     its own destination mid-write is a worse surprise than a dropped field,
 *     so the caller keeps the pen and `declaredName` reports any disagreement.
 *   - `status` — the durable off switch, whose one door is `set_status`.
 *   - `provenance` / `scope` — stamped by the runtime, never author-supplied.
 */

import matter from "gray-matter";
import {
  mapFrontmatterToManifest,
  type SkillFrontmatter,
  type SkillManifest,
  validateFrontmatter,
} from "./schemas/skill-manifest.ts";

/** Manifest fields a pasted document may set — everything the caller and the runtime don't own. */
export type AbsorbedManifestFields = Omit<
  SkillManifest,
  "name" | "status" | "provenance" | "scope"
>;

export type AbsorbedFrontmatter =
  /** No frontmatter block — the body is prose, and nothing changes. */
  | { kind: "absent" }
  /** A block is present and does not satisfy the canonical schema. Never a fallback to prose. */
  | { kind: "invalid"; errors: string[] }
  | {
      kind: "applied";
      /** The document below the frontmatter — what actually gets stored. */
      body: string;
      /** Only the fields the document declared; absent keys keep the caller's value. */
      fields: Partial<AbsorbedManifestFields>;
      /** On-disk field names, as they appear in the pasted file, for the caller to report back. */
      applied: string[];
      /** The `name` the document declared, kept for reporting — it is never applied. */
      declaredName: string;
    };

/**
 * The fields a validated document actually DECLARED, with the mapper's values.
 *
 * `mapFrontmatterToManifest` does the on-disk → runtime transform (it stays the
 * one place that lives), but its defaults are load-bearing here and must not
 * leak: a pristine Agent-Skills source declaring no `nimblebrain` block maps to
 * `dynamic` / priority 50 by default, and applying those over a caller's
 * explicit values would be the same silent overwrite one direction reversed.
 * So the mapper supplies the VALUES and the raw frontmatter decides which keys
 * were declared. Field names are reported as they appear in the file, so the
 * list a caller reads back matches the document in front of them.
 *
 * One asymmetry follows from reading declarations rather than presence: the
 * mapper drops empty arrays, so a document writing `triggers: []` declares
 * nothing and the caller's list stands. A pasted document can therefore ADD a
 * loading signal but never clear one — clearing stays with the editor's own
 * fields, which send their empty forms deliberately.
 */
function declaredFields(fm: SkillFrontmatter): {
  fields: Partial<AbsorbedManifestFields>;
  applied: string[];
} {
  const manifest = mapFrontmatterToManifest(fm);
  const nb = fm.metadata?.nimblebrain;
  const fields: Partial<AbsorbedManifestFields> = {};
  const applied: string[] = [];

  const take = <K extends keyof AbsorbedManifestFields>(key: K, label: string): void => {
    const value = manifest[key];
    if (value === undefined) return;
    fields[key] = value;
    applied.push(label);
  };

  // `description` is required by the schema, so a valid document always has it.
  take("description", "description");
  if (nb) {
    // `loading-strategy` is the block's one required member, so the block being
    // present is exactly the strategy being declared.
    take("loadingStrategy", "loading-strategy");
    if (nb.priority !== undefined) take("priority", "priority");
    take("toolAffinity", "tool-affinity");
    take("triggers", "triggers");
  }
  take("allowedTools", "allowed-tools");
  take("license", "license");
  take("compatibility", "compatibility");
  take("author", "metadata.author");
  take("version", "metadata.version");

  return { fields, applied };
}

/**
 * Does `body` open a CLOSED `---` fence?
 *
 * Checked before parsing, not inferred from the parse, because gray-matter
 * treats an unterminated opening delimiter as a block running to the end of the
 * file: a markdown body that merely opens with a thematic break is swallowed
 * whole and read as YAML. The close is what makes a block a block. This reads
 * delimiters only — the YAML inside is still the canonical parser's business.
 */
function hasClosedFence(body: string): boolean {
  const lines = body.split("\n");
  if (lines[0]?.trimEnd() !== "---") return false;
  return lines.slice(1).some((line) => line.trimEnd() === "---");
}

/** A YAML document that produced keys — anything else declares nothing. */
function isPopulatedMapping(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    Object.keys(data).length > 0
  );
}

/** Split a pasted `SKILL.md` into manifest fields and the body beneath it. */
export function absorbFrontmatter(body: string): AbsorbedFrontmatter {
  if (!hasClosedFence(body)) return { kind: "absent" };

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(body);
  } catch (err) {
    // Malformed YAML inside a well-formed fence — gray-matter throws with the
    // line and column, which is the most actionable thing anyone can say here.
    return { kind: "invalid", errors: [err instanceof Error ? err.message : String(err)] };
  }

  // A fence whose YAML yields no keys states nothing, so there is nothing to
  // apply and nothing to be wrong about: an empty fence, or a pair of thematic
  // breaks with a heading between them. Prose, not a malformed document.
  if (!isPopulatedMapping(parsed.data)) return { kind: "absent" };

  const validation = validateFrontmatter(parsed.data);
  if (!validation.ok) return { kind: "invalid", errors: validation.errors };

  return {
    kind: "applied",
    // `matter` keeps the newline that ended the fence; the writer re-frames the
    // body with its own padding, so trim the seam rather than storing it.
    body: parsed.content.trim(),
    ...declaredFields(validation.value),
    declaredName: validation.value.name,
  };
}
