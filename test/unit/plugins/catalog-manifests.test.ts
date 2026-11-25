/**
 * One plugin format: every manifest the NimbleBrain catalog build emits today
 * validates under the reader system plugins use, unchanged. The extension is
 * additive over what the catalog writes (`servers`, `conversationStarters`,
 * and `nimblebrainOnly` in its AI Catalog), never a second shape.
 */

import { describe, expect, test } from "bun:test";
import {
  extensionProblems,
  nimblebrainExtension,
  type PluginFiles,
  parsePluginManifest,
} from "../../../src/plugins/manifest.ts";
import { readZip } from "../../../src/util/zip.ts";
import { boundSkill, buildCatalog } from "../../helpers/plugin-catalog.ts";

const PATHS = { root: "/plugins/p", data: "/data/p" };

function asFiles(entries: Record<string, unknown>): PluginFiles {
  return new Map(
    Object.entries(entries).map(([path, value]) => [
      path,
      new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value, null, 2)),
    ]),
  );
}

// The files the catalog build writes for a remote server that signs in by DCR,
// in the shape `manifest()`, `mcp_config()` and `claude_mcp_config()` emit.
const PORTABLE = {
  "plugin.json": {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "linear",
    description: "Issues, projects and cycles.",
    author: { name: "NimbleBrain", url: "https://nimblebrain.ai" },
    homepage: "https://linear.app",
    keywords: ["issues", "tickets"],
    extensions: {
      "ai.nimblebrain": {
        servers: { linear: "app.linear/linear" },
        conversationStarters: [
          { title: "What's due this week?", text: "List my issues due this week." },
          { title: "Triage new issues", text: "Show new issues; ask before changing any." },
        ],
      },
    },
  },
  "mcp.json": {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { linear: { type: "streamable-http", url: "https://mcp.linear.app/mcp" } },
  },
  ".mcp.json": { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } },
  "skills/linear/SKILL.md": boundSkill("linear", "linear"),
};

// A brokered connector's plugin: no MCP config, since only NimbleBrain can
// reach its server, and no starters file.
const BROKERED = {
  "plugin.json": {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "gmail",
    description: "Read and send email.",
    author: { name: "NimbleBrain", url: "https://nimblebrain.ai" },
    extensions: { "ai.nimblebrain": { servers: { gmail: "com.google/gmail" } } },
  },
  "skills/gmail/SKILL.md": boundSkill("gmail", "gmail"),
};

describe("the catalog's manifests validate under the one reader", () => {
  test("a portable plugin: servers, starters, mcp.json, Claude Code's .mcp.json beside it", () => {
    const parsed = parsePluginManifest("linear", asFiles(PORTABLE), PATHS);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.mcpServers).toEqual({
      linear: { type: "streamable-http", url: "https://mcp.linear.app/mcp", headers: {} },
    });
    expect(parsed.extension.servers).toEqual({ linear: "app.linear/linear" });
    expect(parsed.extension.conversationStarters).toHaveLength(2);
    expect(parsed.skills).toEqual(["skills/linear"]);
  });

  test("a NimbleBrain-only plugin: a server named in the extension alone, no mcp.json", () => {
    const parsed = parsePluginManifest("gmail", asFiles(BROKERED), PATHS);
    expect(parsed.mcpServers).toEqual({});
    expect(parsed.extension.servers).toEqual({ gmail: "com.google/gmail" });
  });

  test("its AI Catalog entry's extension, nimblebrainOnly alone, validates", () => {
    expect(extensionProblems({ nimblebrainOnly: true })).toEqual([]);
    expect(
      nimblebrainExtension({ extensions: { "ai.nimblebrain": { nimblebrainOnly: true } } }),
    ).toMatchObject({ nimblebrainOnly: true, servers: {} });
  });

  test("every plugin the catalog test fixture builds validates, and reads the same both ways", () => {
    const catalog = buildCatalog([
      {
        name: "gmail",
        servers: { gmail: "com.google/gmail" },
        skills: { gmail: boundSkill("gmail", "gmail") },
      },
      { name: "close", servers: { close: "com.close/mcp" } },
      {
        name: "linear",
        servers: { linear: "app.linear/mcp" },
        conversationStarters: [{ title: "What's due?", text: "List my issues by due date." }],
      },
    ]);
    for (const [name, digest] of Object.entries(catalog.digests)) {
      const url = [...catalog.objects.keys()].find((u) => u.includes(digest))!;
      const files = readZip(catalog.objects.get(url)!);
      const strict = parsePluginManifest(name, files, PATHS);
      const lenient = nimblebrainExtension(
        JSON.parse(new TextDecoder().decode(files.get("plugin.json")!)),
      );
      expect(strict.name).toBe(name);
      expect(strict.extension).toEqual(lenient);
    }
  });
});
