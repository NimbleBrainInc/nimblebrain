import { describe, expect, it } from "bun:test";
import { parseFrontmatter, stringifyFrontmatter } from "../../../src/skills/frontmatter.ts";

const probe = globalThis as { __frontmatterProbe?: number };

describe("parseFrontmatter", () => {
  it("parses a YAML block and the body beneath it", () => {
    const parsed = parseFrontmatter("---\nname: demo\ndescription: d\n---\nbody\n");
    expect(parsed.data).toEqual({ name: "demo", description: "d" });
    expect(parsed.content).toBe("body\n");
  });

  it("accepts a fence that names YAML", () => {
    expect(parseFrontmatter("---yaml\nname: demo\n---\nbody").data).toEqual({ name: "demo" });
  });

  for (const lang of ["js", "javascript", "JS", "coffee", "cson"]) {
    it(`refuses a ---${lang} fence without evaluating it`, () => {
      probe.__frontmatterProbe = 0;
      const text = `---${lang}\n(globalThis.__frontmatterProbe = 1, { name: "x" })\n---\nbody`;
      expect(() => parseFrontmatter(text)).toThrow();
      expect(probe.__frontmatterProbe).toBe(0);
    });
  }

  it("refuses a fence naming a language with no engine", () => {
    expect(() => parseFrontmatter("---toml\nname = 'x'\n---\nbody")).toThrow();
  });

  it("round-trips what stringifyFrontmatter writes", () => {
    const text = stringifyFrontmatter("\nbody\n", { name: "demo" });
    expect(parseFrontmatter(text).data).toEqual({ name: "demo" });
  });
});
