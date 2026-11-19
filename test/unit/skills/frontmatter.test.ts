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

  it("refuses a ---json fence", () => {
    expect(() => parseFrontmatter('---json\n{"name":"x"}\n---\nbody')).toThrow();
  });

  for (const lang of ["json", "js", "toml"]) {
    it(`refuses an empty ---${lang} block`, () => {
      expect(() => parseFrontmatter(`---${lang}\n---\nbody`)).toThrow();
    });
  }

  it("accepts a ---yml fence and an empty YAML block", () => {
    expect(parseFrontmatter("---yml\nname: demo\n---\nbody").data).toEqual({ name: "demo" });
    expect(parseFrontmatter("---\n---\nbody").data).toEqual({});
  });

  it("stringifyFrontmatter refuses a body opening with a JavaScript fence without evaluating it", () => {
    probe.__frontmatterProbe = 0;
    const body = "---js\n(globalThis.__frontmatterProbe = 1, {})\n---\nbody";
    expect(() => stringifyFrontmatter(body, { name: "x" })).toThrow();
    expect(probe.__frontmatterProbe).toBe(0);
  });

  it("round-trips what stringifyFrontmatter writes", () => {
    const text = stringifyFrontmatter("\nbody\n", { name: "demo" });
    expect(parseFrontmatter(text).data).toEqual({ name: "demo" });
  });
});
