/**
 * Tests for `absorbFrontmatter` — recognising a pasted `SKILL.md` in a body.
 *
 * The property under test throughout: a document that states something is
 * never silently overruled, and a document that states nothing never
 * overrules the caller.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { absorbFrontmatter } from "../../../src/skills/authored-frontmatter.ts";

const AUTHORING_GUIDE = join(
  import.meta.dirname ?? __dirname,
  "../../../src/skills/builtin/authoring-guide.md",
);

describe("absorbFrontmatter", () => {
  test("a body with no frontmatter is left entirely alone", () => {
    expect(absorbFrontmatter("Be concise. Avoid em-dashes.")).toEqual({ kind: "absent" });
  });

  test("an unterminated leading `---` is prose, not a broken document", () => {
    // A markdown body may legitimately open with a thematic break. Only a
    // CLOSED fence is a frontmatter block, so this must not reach the error
    // path — the user has written no frontmatter to be wrong about.
    expect(absorbFrontmatter("---\n# Heading\n\nBody text.")).toEqual({ kind: "absent" });
  });

  test("an empty fence declares nothing", () => {
    expect(absorbFrontmatter("---\n---\n\nBody.")).toEqual({ kind: "absent" });
  });

  test("thematic breaks around a heading are prose, not a malformed document", () => {
    // A closed fence whose YAML yields no keys states nothing, so there is
    // nothing to apply and nothing to be wrong about.
    expect(absorbFrontmatter("---\n# Title\n---\n\nBody.")).toEqual({ kind: "absent" });
  });

  test("the platform's own vendored skill round-trips into a manifest", () => {
    // The acceptance case: the canonical artifact of the ecosystem, pasted
    // whole. Every field it states survives, and the YAML does not become body.
    const result = absorbFrontmatter(readFileSync(AUTHORING_GUIDE, "utf-8"));
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;

    expect(result.fields.loadingStrategy).toBe("dynamic");
    expect(result.fields.priority).toBe(25);
    expect(result.fields.toolAffinity).toEqual(["skills__*"]);
    expect(result.fields.triggers).toHaveLength(8);
    expect(result.fields.description).toContain("Guide for authoring");
    expect(result.fields.version).toBe("1.2.0");
    expect(result.declaredName).toBe("authoring-guide");

    // The YAML header is gone; the fenced example INSIDE the guide's prose is
    // body and stays.
    expect(result.body.startsWith("---")).toBe(false);
    expect(result.body).not.toContain("name: authoring-guide");
    expect(result.body).toContain("# Authoring Skills");
  });

  test("a pristine Agent-Skills source declares no loading config, so none is absorbed", () => {
    // `mapFrontmatterToManifest` defaults such a file to `dynamic`/50. Applying
    // those over a caller's explicit values would be the same silent overwrite
    // in the other direction, so only DECLARED keys are reported.
    const result = absorbFrontmatter(
      ["---", "name: plain", "description: A standard skill.", "---", "", "Body."].join("\n"),
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.applied).toEqual(["description"]);
    expect(result.fields.loadingStrategy).toBeUndefined();
    expect(result.fields.priority).toBeUndefined();
  });

  test("a declared nimblebrain block reports every field it set, by its on-disk name", () => {
    const result = absorbFrontmatter(
      [
        "---",
        "name: deploy-helper",
        "description: Helps with deploys.",
        "metadata:",
        "  nimblebrain:",
        "    loading-strategy: dynamic",
        "    triggers:",
        '      - "ship it"',
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.applied).toEqual(["description", "loading-strategy", "triggers"]);
    expect(result.fields.triggers).toEqual(["ship it"]);
    // Not declared, so not reported and not applied.
    expect(result.applied).not.toContain("priority");
    expect(result.applied).not.toContain("tool-affinity");
  });

  test("frontmatter missing a required field is invalid, and the error names it", () => {
    const result = absorbFrontmatter("---\nname: no-description\n---\n\nBody.");
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.errors.join("; ")).toContain("/description");
  });

  test("a field the canonical schema does not know is invalid, not silently dropped", () => {
    const result = absorbFrontmatter(
      ["---", "name: legacy", "description: Old shape.", "type: context", "---", "", "B."].join(
        "\n",
      ),
    );
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.errors.join("; ")).toContain("/type");
  });

  test("malformed YAML inside a well-formed fence is reported, never stored as prose", () => {
    const result = absorbFrontmatter("---\nname: [unclosed\n---\n\nBody.");
    expect(result.kind).toBe("invalid");
  });

  test("`status` and `provenance` are never absorbed — the runtime owns them", () => {
    const result = absorbFrontmatter(
      [
        "---",
        "name: sneaky",
        "description: Tries to set what it may not.",
        "metadata:",
        "  nimblebrain:",
        "    loading-strategy: always",
        "    status: disabled",
        "    provenance:",
        "      origin: admin",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.applied).not.toContain("status");
    expect(result.applied).not.toContain("provenance");
    expect(Object.keys(result.fields)).not.toContain("status");
    expect(Object.keys(result.fields)).not.toContain("provenance");
  });
});
