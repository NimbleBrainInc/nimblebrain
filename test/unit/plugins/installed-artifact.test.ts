import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactError,
  obtainArtifact,
  readArtifact,
} from "../../../src/plugins/installed/artifact.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";
import {
  bareConnectorEntry,
  pluginZip,
  sha256Hex,
  skillMd,
} from "../../helpers/plugin-artifacts.ts";
import { AGENT_PLUGINS_MANIFEST_SCHEMA, zip } from "../../helpers/plugin-catalog.ts";

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "nb-artifact-"));
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

const NOTION = {
  name: "com.notion/mcp",
  url: "https://mcp.notion.test/mcp",
  meta: { auth: "dcr" },
};

function served(bytes: Uint8Array) {
  const requests: string[] = [];
  const fetchImpl = fakeFetch(async (input) => {
    requests.push(String(input));
    return new Response(bytes, { status: 200 });
  });
  return { requests, fetchImpl };
}

function selection(bytes: Uint8Array, over: Record<string, unknown> = {}) {
  return {
    address: "notion@test",
    name: "notion",
    type: "application/agent-plugins+zip",
    url: "https://catalog.test/notion.zip",
    digest: `sha256:${sha256Hex(bytes)}`,
    ...over,
  };
}

describe("obtainArtifact", () => {
  test("fetches once, verifies, and serves the next read from the cache by digest", async () => {
    const bytes = pluginZip({ name: "notion", servers: { notion: NOTION } });
    const { requests, fetchImpl } = served(bytes);
    const first = await obtainArtifact(selection(bytes), { cacheDir, fetchImpl });
    const second = await obtainArtifact(selection(bytes), { cacheDir, fetchImpl });
    expect(first.fetched).toBe(true);
    expect(second.fetched).toBe(false);
    expect(requests).toHaveLength(1);
  });

  test("a digest the bytes do not match is refused, and nothing is cached", async () => {
    const bytes = pluginZip({ name: "notion", servers: { notion: NOTION } });
    const { fetchImpl } = served(bytes);
    const wrong = selection(bytes, { digest: `sha256:${"0".repeat(64)}` });
    await expect(obtainArtifact(wrong, { cacheDir, fetchImpl })).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
    });
    await expect(obtainArtifact(wrong, { cacheDir, fetchImpl })).rejects.toBeInstanceOf(
      ArtifactError,
    );
  });

  test("an entry without a digest is not installable", async () => {
    const bytes = pluginZip({ name: "notion" });
    const { fetchImpl } = served(bytes);
    await expect(
      obtainArtifact(selection(bytes, { digest: undefined }), { cacheDir, fetchImpl }),
    ).rejects.toMatchObject({ code: "NO_DIGEST" });
  });

  test("inline data is verified over its canonical form, whatever its member order", async () => {
    const entry = bareConnectorEntry("crm", NOTION);
    const data = entry.data as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(data).reverse());
    const got = await obtainArtifact(
      {
        address: "crm@test",
        name: "crm",
        type: entry.type as string,
        data: reordered,
        digest: entry.digest as string,
      },
      { cacheDir },
    );
    expect(got.fetched).toBe(false);
    await expect(
      obtainArtifact(
        {
          address: "crm@test",
          name: "crm",
          type: entry.type as string,
          data: { ...data, version: "2" },
          digest: entry.digest as string,
        },
        { cacheDir },
      ),
    ).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
  });
});

describe("readArtifact", () => {
  test("a plugin: its servers' records, bound and unbound skills, and starters", () => {
    const bytes = pluginZip({
      name: "notion",
      servers: { notion: NOTION },
      skills: { usage: skillMd("usage", { server: "notion" }), writing: skillMd("writing") },
      starters: [{ title: "Find a page", text: "Find a page for me." }],
    });
    const contents = readArtifact(selection(bytes), bytes);
    expect(contents.servers.map((s) => [s.key, s.name, s.detail.remotes?.[0]?.url])).toEqual([
      ["notion", "com.notion/mcp", "https://mcp.notion.test/mcp"],
    ]);
    expect(contents.skills.map((s) => [s.name, s.server])).toEqual([
      ["usage", "notion"],
      ["writing", undefined],
    ]);
    expect(contents.starters).toEqual([{ title: "Find a page", text: "Find a page for me." }]);
  });

  test("a stdio server refuses the install, naming it", () => {
    const bytes = pluginZip({ name: "local", servers: { tool: { ...NOTION, stdio: true } } });
    expect(() => readArtifact(selection(bytes), bytes)).toThrow(/"tool" locally \(stdio\)/);
  });

  test("a server with no record in the archive refuses the install", () => {
    const bytes = zip({
      "plugin.json": JSON.stringify({
        $schema: AGENT_PLUGINS_MANIFEST_SCHEMA,
        name: "notion",
        extensions: { "ai.nimblebrain": { servers: { notion: "com.notion/mcp" } } },
      }),
    });
    expect(() => readArtifact(selection(bytes), bytes)).toThrow(
      /"notion" has no record at ai\.nimblebrain\/servers\/notion\.json/,
    );
  });

  test("a bare connector is a one-server plugin keyed by its name", () => {
    const entry = bareConnectorEntry("crm", NOTION);
    const contents = readArtifact(
      { address: "crm@test", name: "crm", type: entry.type as string, data: entry.data },
      new TextEncoder().encode(JSON.stringify(entry.data)),
    );
    expect(contents.servers.map((s) => [s.key, s.name])).toEqual([["crm", "com.notion/mcp"]]);
    expect(contents.skills).toEqual([]);
  });

  test("a bare skill is a one-skill plugin, from a SKILL.md or a skills zip", () => {
    const md = new TextEncoder().encode(skillMd("notes"));
    const one = readArtifact(
      { address: "notes@test", name: "notes", type: "application/agent-skills+md" },
      md,
    );
    expect(one.skills.map((s) => s.name)).toEqual(["notes"]);
    expect(one.servers).toEqual([]);
    const zipped = zip({ "notes/SKILL.md": skillMd("notes") });
    const two = readArtifact(
      { address: "notes@test", name: "notes", type: "application/agent-skills+zip" },
      zipped,
    );
    expect(two.skills.map((s) => s.name)).toEqual(["notes"]);
  });
});
