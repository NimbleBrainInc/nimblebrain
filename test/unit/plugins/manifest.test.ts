import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandPluginVars,
  nimblebrainExtension,
  type PluginFiles,
  PluginManifestError,
  parsePluginManifest,
  readPluginDirectory,
  remoteUrlProblem,
} from "../../../src/plugins/manifest.ts";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PATHS = { root: "/plugins/notes", data: "/data/notes" };

function files(entries: Record<string, unknown>): PluginFiles {
  return new Map(
    Object.entries(entries).map(([path, value]) => [
      path,
      new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)),
    ]),
  );
}

function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { $schema: PLUGIN_SCHEMA, name: "notes", ...extra };
}

function mcp(servers: Record<string, unknown>): Record<string, unknown> {
  return { $schema: MCP_SCHEMA, mcpServers: servers };
}

/** The problems a parse throws, as `file field: message` lines. */
function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof PluginManifestError) {
      return err.problems.map((p) => `${p.file} ${p.field}: ${p.message}`);
    }
    throw err;
  }
  throw new Error("expected a PluginManifestError");
}

describe("parsePluginManifest", () => {
  test("reads a plugin: metadata, servers with placeholders expanded, skills, extension", () => {
    const parsed = parsePluginManifest(
      "notes",
      files({
        "plugin.json": manifest({
          version: "1.2.0",
          description: "Notes.",
          extensions: {
            "ai.nimblebrain": {
              $schema:
                "https://schemas.nimblebrain.ai/plugin-extension/v1/plugin-extension.schema.json",
              implements: [
                { contract: "ai.nimblebrain.conversations", version: "1.0", server: "records" },
              ],
              requires: [{ contract: "ai.nimblebrain.files", version: "1.0", optional: true }],
            },
            "com.other.client": { anything: true },
          },
        }),
        "mcp.json": mcp({
          app: { type: "streamable-http", url: "https://notes.example/mcp" },
          records: {
            type: "stdio",
            command: "./bin/records",
            args: ["--data", "${PLUGIN_DATA}/db", "${PLUGIN_ROOT}${PLUGIN_DATA}"],
            env: { CONFIG: "${PLUGIN_ROOT}/config.json", LITERAL: "${HOME}" },
            cwd: "${PLUGIN_DATA}",
          },
        }),
        "skills/usage/SKILL.md": "---\nname: usage\n---\n",
        "skills/a/SKILL.md": "---\nname: a\n---\n",
        "skills/usage/references/x.md": "not a skill",
      }),
      PATHS,
    );
    expect(parsed).toEqual({
      name: "notes",
      version: "1.2.0",
      description: "Notes.",
      mcpServers: {
        app: { type: "streamable-http", url: "https://notes.example/mcp", headers: {} },
        records: {
          type: "stdio",
          command: "/plugins/notes/bin/records",
          args: ["--data", "/data/notes/db", "/plugins/notes/data/notes"],
          env: { CONFIG: "/plugins/notes/config.json", LITERAL: "${HOME}" },
          cwd: "/data/notes",
        },
      },
      skills: ["skills/a", "skills/usage"],
      extension: {
        servers: {},
        conversationStarters: [],
        nimblebrainOnly: false,
        implements: [
          { contract: "ai.nimblebrain.conversations", version: "1.0", server: "records" },
        ],
        requires: [{ contract: "ai.nimblebrain.files", version: "1.0", optional: true }],
      },
      warnings: [],
    });
  });

  test("a plugin with no mcp.json and no extension has no servers and an empty extension", () => {
    const parsed = parsePluginManifest("notes", files({ "plugin.json": manifest() }), PATHS);
    expect(parsed.mcpServers).toEqual({});
    expect(parsed.extension).toEqual({
      servers: {},
      conversationStarters: [],
      nimblebrainOnly: false,
      implements: [],
      requires: [],
    });
  });

  test("an unknown top-level field is reported and ignored, as the format requires", () => {
    const parsed = parsePluginManifest(
      "notes",
      files({ "plugin.json": manifest({ commands: ["x"] }) }),
      PATHS,
    );
    expect(parsed.warnings).toEqual(['plugin.json: unknown field "commands" ignored']);
  });

  test("a missing or unreadable plugin.json is refused, naming the plugin", () => {
    expect(problemsOf(() => parsePluginManifest("notes", files({}), PATHS))).toEqual([
      "plugin.json : missing: an Agent Plugin has plugin.json at its root",
    ]);
    try {
      parsePluginManifest("notes", files({ "plugin.json": "{nope" }), PATHS);
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginManifestError);
      expect((err as PluginManifestError).plugin).toBe("notes");
      expect((err as Error).message).toMatch(/^plugin notes: plugin\.json: not valid JSON/);
    }
  });

  test("the manifest is held to the format's schema, naming each field", () => {
    const problems = problemsOf(() =>
      parsePluginManifest(
        "notes",
        files({ "plugin.json": { name: "Bad--Name", author: { name: "x", role: "y" } } }),
        PATHS,
      ),
    );
    expect(problems).toContain("plugin.json : must have required property '$schema'");
    expect(problems.some((p) => p.startsWith("plugin.json name: must match pattern"))).toBe(true);
    expect(problems).toContain('plugin.json author: unknown field "role"');
  });

  test("the extension is held to its schema, naming each field", () => {
    const problems = problemsOf(() =>
      parsePluginManifest(
        "notes",
        files({
          "plugin.json": manifest({
            extensions: {
              "ai.nimblebrain": {
                servers: { notes: 3 },
                conversationStarters: [{ title: "x".repeat(61), text: "t" }],
                implements: [{ contract: "Not A Contract", version: "1", server: "" }],
                requires: [{ contract: "ai.nimblebrain.files" }],
              },
            },
          }),
        }),
        PATHS,
      ),
    );
    const at = 'plugin.json extensions["ai.nimblebrain"]';
    expect(problems).toEqual(
      expect.arrayContaining([
        `${at}.servers.notes: must be string`,
        `${at}.conversationStarters[0].title: must NOT have more than 60 characters`,
        `${at}.implements[0].contract: must match pattern "^[a-z0-9]+(\\.[a-z0-9-]+)+$"`,
        `${at}.implements[0].version: must match pattern "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"`,
        `${at}.implements[0].server: must NOT have fewer than 1 characters`,
        `${at}.requires[0]: must have required property 'version'`,
      ]),
    );
  });

  test("an implementation names a server in mcp.json, never one named only by its registry name", () => {
    const ext = (server: string) => ({
      extensions: {
        "ai.nimblebrain": {
          servers: { brokered: "com.example/brokered" },
          implements: [{ contract: "ai.example.thing", version: "1.0", server }],
        },
      },
    });
    const mcpJson = mcp({ app: { type: "streamable-http", url: "https://x.example/mcp" } });
    expect(() =>
      parsePluginManifest(
        "notes",
        files({ "plugin.json": manifest(ext("app")), "mcp.json": mcpJson }),
        PATHS,
      ),
    ).not.toThrow();
    for (const server of ["nowhere", "brokered"]) {
      expect(
        problemsOf(() =>
          parsePluginManifest(
            "notes",
            files({ "plugin.json": manifest(ext(server)), "mcp.json": mcpJson }),
            PATHS,
          ),
        ),
      ).toEqual([
        `plugin.json extensions["ai.nimblebrain"].implements[0].server: "${server}" is not a server in mcp.json`,
      ]);
    }
  });

  test("a contract implemented twice is refused", () => {
    const impl = { contract: "ai.example.thing", version: "1.0", server: "x" };
    const problems = problemsOf(() =>
      parsePluginManifest(
        "notes",
        files({
          "plugin.json": manifest({
            extensions: {
              "ai.nimblebrain": { implements: [impl, impl] },
            },
          }),
          "mcp.json": mcp({ x: { type: "streamable-http", url: "https://x.example/mcp" } }),
        }),
        PATHS,
      ),
    );
    expect(problems).toEqual([
      'plugin.json extensions["ai.nimblebrain"].implements[1].contract: ai.example.thing is implemented twice',
    ]);
  });

  test("mcp.json is held to the format's schema and its prose rules", () => {
    const problems = problemsOf(() =>
      parsePluginManifest(
        "notes",
        files({
          "plugin.json": manifest(),
          "mcp.json": {
            mcpServers: {
              spaced: { type: "stdio", command: "node server.js" },
              absolute: { type: "stdio", command: "/usr/bin/node" },
              nested: { type: "stdio", command: "bin/server" },
              escapes: { type: "stdio", command: "./bin/../../x" },
              reserved: { type: "stdio", command: "x", env: { PLUGIN_ROOT: "/" } },
              outside: { type: "stdio", command: "x", cwd: "${PLUGIN_DATA}/../elsewhere" },
              cleartext: { type: "streamable-http", url: "http://notes.example/mcp" },
              userinfo: { type: "streamable-http", url: "https://u:p@notes.example/mcp" },
              twice: {
                type: "streamable-http",
                url: "https://notes.example/mcp",
                headers: { "X-A": "1", "x-a": "2" },
              },
              legacy: { type: "sse", url: "https://notes.example/sse" },
              extra: { type: "streamable-http", url: "https://notes.example/mcp", command: "x" },
              unknown: { type: "websocket" },
            },
          },
        }),
        PATHS,
      ),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "mcp.json : must have required property '$schema'",
        "mcp.json mcpServers.spaced.command: must be one executable token; arguments go in args",
        "mcp.json mcpServers.absolute.command: must be a bare name or ./-relative, not absolute",
        "mcp.json mcpServers.nested.command: must be a bare name or start with ./",
        "mcp.json mcpServers.escapes.command: must stay inside the plugin",
        "mcp.json mcpServers.reserved.env: property name must be valid",
        "mcp.json mcpServers.outside.cwd: must stay inside the plugin's root or data",
        "mcp.json mcpServers.cleartext.url: must be https unless its host is loopback",
        "mcp.json mcpServers.userinfo.url: must not carry user information",
        'mcp.json mcpServers.twice.headers: "x-a" appears twice under different casing',
        "mcp.json mcpServers.legacy.type: the sse transport is not supported; use streamable-http",
        'mcp.json mcpServers.extra: unknown field "command"',
        'mcp.json mcpServers.unknown.type: must be "stdio" or "streamable-http"',
      ]),
    );
  });
});

describe("nimblebrainExtension", () => {
  test("keeps each well-formed field and drops a malformed one", () => {
    const ext = nimblebrainExtension({
      extensions: {
        "ai.nimblebrain": {
          servers: { good: "com.example/good", bad: 3 },
          conversationStarters: [
            { title: "  Trimmed  ", text: "  yes  " },
            { title: "", text: "no title" },
            "not a mapping",
          ],
          nimblebrainOnly: "yes",
          implements: [
            { contract: "ai.example.x", version: "1.0", server: "b" },
            { contract: "ai.example.y", version: "1.0", server: 1 },
            {},
          ],
          requires: [
            { contract: "ai.example.y", version: "1.0", optional: "no" },
            { version: "1.0" },
          ],
        },
      },
    });
    expect(ext).toEqual({
      servers: { good: "com.example/good" },
      conversationStarters: [{ title: "Trimmed", text: "yes" }],
      nimblebrainOnly: false,
      implements: [{ contract: "ai.example.x", version: "1.0", server: "b" }],
      requires: [{ contract: "ai.example.y", version: "1.0" }],
    });
  });

  test("a manifest with no extension, or a non-object one, reads as empty", () => {
    const empty = {
      servers: {},
      conversationStarters: [],
      nimblebrainOnly: false,
      implements: [],
      requires: [],
    };
    expect(nimblebrainExtension({})).toEqual(empty);
    expect(nimblebrainExtension({ extensions: [] })).toEqual(empty);
    expect(nimblebrainExtension(null)).toEqual(empty);
  });
});

describe("expandPluginVars", () => {
  test("replaces only the two placeholders, in one non-recursive pass", () => {
    const paths = { root: "/r/${PLUGIN_DATA}", data: "/d" };
    expect(expandPluginVars("${PLUGIN_ROOT}/x:${PLUGIN_DATA}:${OTHER}", paths)).toBe(
      "/r/${PLUGIN_DATA}/x:/d:${OTHER}",
    );
  });
});

describe("remoteUrlProblem", () => {
  test("https anywhere, http only on loopback", () => {
    expect(remoteUrlProblem("https://a.example/mcp")).toBeNull();
    expect(remoteUrlProblem("http://localhost:3000/mcp")).toBeNull();
    expect(remoteUrlProblem("http://127.0.0.1/mcp")).toBeNull();
    expect(remoteUrlProblem("http://[::1]/mcp")).toBeNull();
    expect(remoteUrlProblem("http://a.example/mcp")).toMatch(/https/);
    expect(remoteUrlProblem("https://a.example/mcp#x")).toMatch(/fragment/);
    expect(remoteUrlProblem("ftp://a.example")).toMatch(/http or https/);
    expect(remoteUrlProblem("/relative")).toMatch(/absolute/);
  });
});

describe("readPluginDirectory", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("reads plugin.json, mcp.json and each skill's SKILL.md, nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-dir-"));
    dirs.push(root);
    writeFileSync(join(root, "plugin.json"), "{}");
    writeFileSync(join(root, "mcp.json"), "{}");
    mkdirSync(join(root, "skills", "usage", "references"), { recursive: true });
    writeFileSync(join(root, "skills", "usage", "SKILL.md"), "x");
    writeFileSync(join(root, "skills", "usage", "references", "a.md"), "x");
    mkdirSync(join(root, "skills", "empty"));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "server"), "x");
    expect([...readPluginDirectory(root).keys()].sort()).toEqual([
      "mcp.json",
      "plugin.json",
      "skills/usage/SKILL.md",
    ]);
  });
});
