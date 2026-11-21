import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pinnedIndexUrl,
  type ResolveServerSkillsOptions,
  resolveServerConversationStarters,
  resolveServerSkills,
} from "../../../src/skills/connector-skill-resolver.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";
import {
  boundSkill,
  buildCatalog,
  type FixtureCatalog,
  sha256,
  TEST_CATALOG_URL,
  zip,
} from "../../helpers/plugin-catalog.ts";

const dirs: string[] = [];
function tmpCache(): string {
  const d = mkdtempSync(join(tmpdir(), "plugin-skills-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

const GMAIL = boundSkill("gmail", "gmail", "Confirm the recipient before sending.");

function catalog(): FixtureCatalog {
  return buildCatalog([
    { name: "gmail", servers: { gmail: "com.google/gmail" }, skills: { gmail: GMAIL } },
    {
      name: "notion",
      servers: { notion: "com.notion/mcp" },
      skills: {
        // Names no server: not a connector's guidance.
        notes: "---\nname: notes\ndescription: General notes.\n---\n\nBody.\n",
      },
    },
    { name: "close", servers: { close: "com.close/mcp" } },
  ]);
}

function opts(c: FixtureCatalog, cacheDir = tmpCache()): ResolveServerSkillsOptions {
  return { cacheDir, catalogUrl: TEST_CATALOG_URL, pin: c.pin, fetchImpl: c.fetch };
}

describe("resolveServerSkills", () => {
  test("reads the skill a plugin binds to the server, pinned and digested", async () => {
    const c = catalog();
    const skills = await resolveServerSkills("com.google/gmail", opts(c));
    expect(skills).toEqual([
      {
        plugin: "gmail",
        catalog: "nimblebrain",
        digest: c.digests.gmail!,
        skill: "gmail",
        body: GMAIL,
        sha: sha256(new TextEncoder().encode(GMAIL)),
      },
    ]);
    expect(c.requests[0]).toBe(pinnedIndexUrl(TEST_CATALOG_URL, c.pin));
  });

  test("a server no plugin names, or whose plugin binds no skill, has none", async () => {
    const c = catalog();
    const o = opts(c);
    expect(await resolveServerSkills("com.unknown/mcp", o)).toEqual([]);
    expect(await resolveServerSkills("com.close/mcp", o)).toEqual([]);
    expect(await resolveServerSkills("com.notion/mcp", o)).toEqual([]);
  });

  test("fails closed when the pinned index is missing", async () => {
    const c = catalog();
    const o = { ...opts(c), pin: "f".repeat(64) };
    await expect(resolveServerSkills("com.google/gmail", o)).rejects.toThrow(/HTTP 404/);
  });

  test("fails closed when the index's bytes do not match the pin", async () => {
    const c = catalog();
    const url = pinnedIndexUrl(TEST_CATALOG_URL, c.pin);
    c.objects.set(url, new TextEncoder().encode('{"name":"nimblebrain","plugins":[]}'));
    await expect(resolveServerSkills("com.google/gmail", opts(c))).rejects.toThrow(
      /catalog index integrity mismatch/,
    );
  });

  test("fails closed when a plugin archive does not match its listed digest", async () => {
    const c = catalog();
    const url = [...c.objects.keys()].find((u) => u.includes(c.digests.gmail!))!;
    c.objects.set(url, new Uint8Array([1, 2, 3]));
    await expect(resolveServerSkills("com.google/gmail", opts(c))).rejects.toThrow(
      /plugin gmail integrity mismatch/,
    );
  });

  test("fails closed on a network error", async () => {
    const c = catalog();
    const o = {
      ...opts(c),
      fetchImpl: fakeFetch(async () => {
        throw new Error("network down");
      }),
    };
    await expect(resolveServerSkills("com.google/gmail", o)).rejects.toThrow(/network down/);
  });

  test("caches by content: a second resolve reads nothing from the network", async () => {
    const c = catalog();
    const o = opts(c);
    await resolveServerSkills("com.google/gmail", o);
    const fetched = c.requests.length;
    expect(fetched).toBe(4); // the index and three archives
    const again = await resolveServerSkills("com.google/gmail", {
      ...o,
      fetchImpl: fakeFetch(async () => {
        throw new Error("offline");
      }),
    });
    expect(again).toHaveLength(1);
  });

  test("a tampered cached index is refused, not served", async () => {
    const c = catalog();
    const o = opts(c);
    await resolveServerSkills("com.google/gmail", o);
    writeFileSync(join(o.cacheDir, "index", `${c.pin}.json`), '{"name":"x","plugins":[]}');
    await expect(resolveServerSkills("com.google/gmail", o)).rejects.toThrow(/integrity mismatch/);
  });

  test("a tampered cached plugin archive is refused, not served", async () => {
    const c = catalog();
    const o = opts(c);
    await resolveServerSkills("com.google/gmail", o);
    const digest = c.digests.gmail!;
    const tampered = zip({
      "plugin.json": JSON.stringify({
        extensions: { "ai.nimblebrain": { servers: { gmail: "com.google/gmail" } } },
      }),
      "skills/gmail/SKILL.md": boundSkill("gmail", "gmail", "Altered guidance."),
    });
    writeFileSync(join(o.cacheDir, "plugins", `${digest}.zip`), tampered);
    await expect(resolveServerSkills("com.google/gmail", o)).rejects.toThrow(/integrity mismatch/);
  });

  test("a new pin refetches only the plugins whose bytes changed", async () => {
    const cacheDir = tmpCache();
    const first = catalog();
    await resolveServerSkills("com.google/gmail", opts(first, cacheDir));

    const next = buildCatalog([
      {
        name: "gmail",
        servers: { gmail: "com.google/gmail" },
        skills: { gmail: boundSkill("gmail", "gmail", "Newer guidance.") },
      },
      {
        name: "notion",
        servers: { notion: "com.notion/mcp" },
        skills: { notes: "---\nname: notes\ndescription: General notes.\n---\n\nBody.\n" },
      },
      { name: "close", servers: { close: "com.close/mcp" } },
    ]);
    expect(next.pin).not.toBe(first.pin);
    const skills = await resolveServerSkills("com.google/gmail", opts(next, cacheDir));
    expect(skills[0]!.body).toContain("Newer guidance.");
    expect(next.requests).toEqual([
      pinnedIndexUrl(TEST_CATALOG_URL, next.pin),
      [...next.objects.keys()].find((u) => u.includes(next.digests.gmail!))!,
    ]);
  });
});

describe("resolveServerConversationStarters", () => {
  const STARTERS = [
    { title: "Summarize my unread email", text: "Summarize my unread email from today." },
    { title: "Draft replies", text: "Draft replies; don't send anything." },
  ];

  function starterCatalog(): FixtureCatalog {
    return buildCatalog([
      { name: "gmail", servers: { gmail: "com.google/gmail" }, conversationStarters: STARTERS },
      { name: "notion", servers: { notion: "com.notion/mcp" } },
      {
        name: "linear",
        servers: { linear: "app.linear/mcp" },
        conversationStarters: [
          { title: "  What's due?  ", text: "  List my issues by due date.  " },
          { title: "", text: "no title" },
          { title: "x".repeat(61), text: "too long a title" },
          { title: "no text" },
          "not a mapping",
          { title: "One", text: "1" },
          { title: "Two", text: "2" },
          { title: "Three", text: "3" },
          { title: "Four", text: "4" },
        ],
      },
    ]);
  }

  test("returns the starters of each plugin that names an asked-for server", async () => {
    const c = starterCatalog();
    const out = await resolveServerConversationStarters(
      ["com.google/gmail", "com.notion/mcp"],
      opts(c),
    );
    expect(out).toEqual([
      { server: "com.google/gmail", plugin: "gmail", conversationStarters: STARTERS },
    ]);
  });

  test("keeps only well-formed starters, trimmed, and at most four", async () => {
    const c = starterCatalog();
    const [linear] = await resolveServerConversationStarters(["app.linear/mcp"], opts(c));
    expect(linear?.conversationStarters).toEqual([
      { title: "What's due?", text: "List my issues by due date." },
      { title: "One", text: "1" },
      { title: "Two", text: "2" },
      { title: "Three", text: "3" },
    ]);
  });

  test("asks for nothing when no server is named", async () => {
    const c = starterCatalog();
    expect(await resolveServerConversationStarters([], opts(c))).toEqual([]);
    expect(c.requests).toEqual([]);
  });

  test("a server no plugin names has no starters", async () => {
    const c = starterCatalog();
    expect(await resolveServerConversationStarters(["com.unknown/mcp"], opts(c))).toEqual([]);
  });
});
