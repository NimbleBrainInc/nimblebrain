import { describe, expect, it } from "bun:test";
import { readZip, ZIP_MAX_TOTAL_BYTES } from "../../../src/util/zip.ts";
import { zip } from "../../helpers/plugin-catalog.ts";

const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe("readZip", () => {
  it("reads every file of a deflated archive by its path", () => {
    const files = readZip(zip({ "plugin.json": "{}", "skills/a/SKILL.md": "# A\n" }));
    expect([...files.keys()].sort()).toEqual(["plugin.json", "skills/a/SKILL.md"]);
    expect(text(files.get("skills/a/SKILL.md"))).toBe("# A\n");
  });

  it("reads an empty deflated file", () => {
    const files = readZip(zip({ "plugin.json": "{}", ".gitkeep": "" }));
    expect(files.get(".gitkeep")?.byteLength).toBe(0);
  });

  it("refuses a path that leaves the archive root", () => {
    expect(() => readZip(zip({ "../evil.md": "x" }))).toThrow(/not a relative path/);
    expect(() => readZip(zip({ "/abs.md": "x" }))).toThrow(/not a relative path/);
  });

  it("refuses an archive that expands past its cap", () => {
    const big = new Uint8Array(ZIP_MAX_TOTAL_BYTES + 1);
    expect(() => readZip(zip({ "big.bin": big }))).toThrow(/size cap/);
  });

  it("refuses bytes that are not a zip", () => {
    expect(() => readZip(new TextEncoder().encode("not a zip at all, just text"))).toThrow(
      /end of central directory/,
    );
  });
});
