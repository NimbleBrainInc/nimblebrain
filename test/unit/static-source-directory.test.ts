import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../../src/cli/log.ts";
import { readStaticServers } from "../../src/registries/static-source.ts";

/**
 * Directory-reading mechanics for `StaticSource`. A static registry's
 * path may be a single file (legacy) or a directory of catalog files
 * (the GitOps shape — split curation across files that roll up to one
 * registry). These pin the aggregation, dedup, ordering, and
 * resilience contract.
 */

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nb-static-dir-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Minimal valid ServerDetail YAML entry for the given reverse-DNS name. */
function entry(name: string, description = "An entry"): string {
  return `  - name: ${name}
    description: ${description}
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: https://example.com/mcp
`;
}

function catalog(...entries: string[]): string {
  return `servers:\n${entries.join("")}`;
}

describe("StaticSource directory reading", () => {
  test("aggregates entries across every catalog file in the directory", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeFileSync(join(dir, "curated.yaml"), catalog(entry("com.a/mcp")));
      writeFileSync(join(dir, "composio.yaml"), catalog(entry("com.b/mcp")));
      const names = readStaticServers(dir).map((s) => s.name);
      expect(names.sort()).toEqual(["com.a/mcp", "com.b/mcp"]);
    } finally {
      cleanup();
    }
  });

  test("reads JSON catalog files too", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeFileSync(join(dir, "a.yaml"), catalog(entry("com.a/mcp")));
      writeFileSync(
        join(dir, "b.json"),
        JSON.stringify({
          servers: [
            {
              name: "com.b/mcp",
              description: "json entry",
              version: "1.0.0",
              remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
            },
          ],
        }),
      );
      const names = readStaticServers(dir).map((s) => s.name);
      expect(names.sort()).toEqual(["com.a/mcp", "com.b/mcp"]);
    } finally {
      cleanup();
    }
  });

  test("dedups duplicate names across files, first file (sorted) wins", () => {
    const { dir, cleanup } = tmpDir();
    try {
      // Same name in both files; "a.yaml" sorts before "b.yaml" so its
      // description survives.
      writeFileSync(join(dir, "a.yaml"), catalog(entry("com.dup/mcp", "from a")));
      writeFileSync(join(dir, "b.yaml"), catalog(entry("com.dup/mcp", "from b")));
      const servers = readStaticServers(dir);
      expect(servers).toHaveLength(1);
      expect(servers[0]?.description).toBe("from a");
    } finally {
      cleanup();
    }
  });

  test("ignores non-catalog files in the directory", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeFileSync(join(dir, "curated.yaml"), catalog(entry("com.a/mcp")));
      writeFileSync(join(dir, "README.md"), "# not a catalog\n");
      writeFileSync(join(dir, "notes.txt"), "ignore me");
      const names = readStaticServers(dir).map((s) => s.name);
      expect(names).toEqual(["com.a/mcp"]);
    } finally {
      cleanup();
    }
  });

  test("invalid-entry warnings name the originating file, not the directory", () => {
    const { dir, cleanup } = tmpDir();
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      writeFileSync(join(dir, "good.yaml"), catalog(entry("com.good/mcp")));
      // Missing `version` → dropped by ServerDetail validation.
      writeFileSync(
        join(dir, "bad.yaml"),
        `servers:
  - name: com.bad/mcp
    description: no version
    remotes:
      - type: streamable-http
        url: https://example.com/mcp
`,
      );
      readStaticServers(dir);
      const dropLine = warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes("com.bad/mcp") && m.includes("dropped"));
      expect(dropLine).toBeDefined();
      // Tagged with the file path, so a multi-file curated dir is actionable.
      expect(dropLine).toContain("bad.yaml");
    } finally {
      warn.mockRestore();
      cleanup();
    }
  });

  test("a malformed file is skipped; sibling files still load", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeFileSync(join(dir, "good.yaml"), catalog(entry("com.good/mcp")));
      writeFileSync(join(dir, "broken.yaml"), "servers: [ this: is: not: valid yaml");
      const names = readStaticServers(dir).map((s) => s.name);
      expect(names).toEqual(["com.good/mcp"]);
    } finally {
      cleanup();
    }
  });

  test("an empty directory yields no servers", () => {
    const { dir, cleanup } = tmpDir();
    try {
      expect(readStaticServers(dir)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a missing path yields no servers", () => {
    expect(readStaticServers(join(tmpdir(), "nb-does-not-exist-xyz"))).toEqual([]);
  });

  test("still reads a single file (non-directory path)", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const file = join(dir, "catalog.yaml");
      writeFileSync(file, catalog(entry("com.a/mcp"), entry("com.b/mcp")));
      const names = readStaticServers(file).map((s) => s.name);
      expect(names.sort()).toEqual(["com.a/mcp", "com.b/mcp"]);
    } finally {
      cleanup();
    }
  });
});
