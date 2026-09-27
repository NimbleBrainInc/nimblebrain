/**
 * The host-side checks of the Skills extension (SEP-2640): which `skills/list`
 * entries are loadable, and whether a fetched `SKILL.md` is the one the listing
 * described. Plus `McpSource.listSkills`, the enumeration those checks run on.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { disambiguateSkillNames } from "../../../src/skills/connector-skills.ts";
import {
  listedSkillFiles,
  parseSkillEntry,
  SKILLS_EXTENSION_ID,
  type SkillEntry,
  verifySkillEntrypoint,
} from "../../../src/skills/skills-extension.ts";
import { McpSource } from "../../../src/tools/mcp-source.ts";
import { makeInProcessSource } from "../../helpers/in-process-source.ts";

const SKILL_MD = `---
name: refunds
description: Process refunds
metadata:
  nimblebrain:
    loading-strategy: always
---

# Refunds
`;

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(new TextEncoder().encode(text)).digest("hex")}`;
}

function entryFor(text: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
  const uri = "skill://acme/billing/refunds/SKILL.md";
  return {
    uri,
    frontmatter: {
      name: "refunds",
      description: "Process refunds",
      metadata: { nimblebrain: { "loading-strategy": "always" } },
    },
    resources: [{ uri, digest: digestOf(text), size: new TextEncoder().encode(text).byteLength }],
    ...overrides,
  };
}

describe("parseSkillEntry", () => {
  it("accepts a conforming entry, with a manifest or dynamic", () => {
    expect(parseSkillEntry(entryFor(SKILL_MD))).not.toBeNull();
    expect(parseSkillEntry({ ...entryFor(SKILL_MD), resources: "dynamic" })).not.toBeNull();
  });

  it("rejects an entry with no resources, or resources of another shape", () => {
    const { resources: _omit, ...noResources } = entryFor(SKILL_MD);
    expect(parseSkillEntry(noResources)).toBeNull();
    expect(parseSkillEntry({ ...entryFor(SKILL_MD), resources: "static" })).toBeNull();
    expect(
      parseSkillEntry({
        ...entryFor(SKILL_MD),
        resources: [{ uri: "skill://acme/billing/refunds/SKILL.md", digest: "md5:x", size: 1 }],
      }),
    ).toBeNull();
  });

  it("rejects a uri whose final segment is not frontmatter.name", () => {
    expect(
      parseSkillEntry({ ...entryFor(SKILL_MD), uri: "skill://acme/billing/other/SKILL.md" }),
    ).toBeNull();
  });

  it("rejects a uri that is not a SKILL.md, and frontmatter without description", () => {
    expect(parseSkillEntry({ ...entryFor(SKILL_MD), uri: "skill://refunds/README.md" })).toBeNull();
    expect(parseSkillEntry({ ...entryFor(SKILL_MD), frontmatter: { name: "refunds" } })).toBeNull();
  });

  it("accepts a skill served under a scheme other than skill://", () => {
    const uri = "github://acme/repo/skills/refunds/SKILL.md";
    const entry = entryFor(SKILL_MD, { uri });
    expect(parseSkillEntry({ ...entry, resources: "dynamic" })).not.toBeNull();
  });
});

describe("verifySkillEntrypoint", () => {
  it("passes the bytes and frontmatter the listing described", () => {
    expect(verifySkillEntrypoint(entryFor(SKILL_MD), SKILL_MD)).toEqual({ ok: true });
  });

  it("fails a changed body as a size or digest mismatch", () => {
    const entry = entryFor(SKILL_MD);
    expect(verifySkillEntrypoint(entry, `${SKILL_MD}more`)).toEqual({
      ok: false,
      reason: "size_mismatch",
    });
    // Same length, different bytes.
    const swapped = SKILL_MD.replace("Refunds\n", "Refundz\n");
    expect(verifySkillEntrypoint(entry, swapped)).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  it("fails an entry whose manifest omits its own SKILL.md", () => {
    const entry = entryFor(SKILL_MD, {
      resources: [{ uri: "skill://acme/billing/refunds/other.md", digest: digestOf("x"), size: 1 }],
    });
    expect(verifySkillEntrypoint(entry, SKILL_MD)).toEqual({ ok: false, reason: "unlisted" });
  });

  it("fails frontmatter that differs from the listing, even when the digest matches", () => {
    const entry = entryFor(SKILL_MD, {
      frontmatter: { name: "refunds", description: "Process refunds" },
    });
    expect(verifySkillEntrypoint(entry, SKILL_MD)).toEqual({
      ok: false,
      reason: "frontmatter_mismatch",
    });
  });

  it("matches a YAML date against the listing's string for the same instant", () => {
    const text = "---\nname: refunds\ndescription: Process refunds\nreleased: 2026-01-01\n---\nbody\n";
    const listed = (released: string) =>
      entryFor(text, {
        frontmatter: { name: "refunds", description: "Process refunds", released },
      });
    expect(verifySkillEntrypoint(listed("2026-01-01"), text)).toEqual({ ok: true });
    expect(verifySkillEntrypoint(listed("2026-01-01T00:00:00.000Z"), text)).toEqual({ ok: true });
    expect(verifySkillEntrypoint(listed("2026-01-02"), text).ok).toBe(false);
  });

  it("checks only frontmatter for a dynamic skill", () => {
    const entry = entryFor(SKILL_MD, { resources: "dynamic" });
    expect(verifySkillEntrypoint(entry, `${SKILL_MD}\nextra body`)).toEqual({ ok: true });
    const other = SKILL_MD.replace("Process refunds", "Something else");
    expect(verifySkillEntrypoint(entry, other).ok).toBe(false);
  });

  it("lists the manifest's files, or none for a dynamic skill", () => {
    expect(listedSkillFiles(entryFor(SKILL_MD))).toEqual(["skill://acme/billing/refunds/SKILL.md"]);
    expect(listedSkillFiles(entryFor(SKILL_MD, { resources: "dynamic" }))).toBeNull();
  });
});

describe("disambiguateSkillNames", () => {
  const skill = (uri: string, name: string) => ({ uri, name, description: "", body: "" });

  it("names colliding skills by their skill path and leaves unique names alone", () => {
    const out = disambiguateSkillNames([
      skill("skill://acme/billing/refunds/SKILL.md", "refunds"),
      skill("skill://acme/support/refunds/SKILL.md", "refunds"),
      skill("skill://git-workflow/SKILL.md", "git-workflow"),
    ]);
    expect(out.map((s) => s.name)).toEqual([
      "acme/billing/refunds",
      "acme/support/refunds",
      "git-workflow",
    ]);
  });
});

/**
 * An `McpSource` whose SDK client is a stub, on the given era. The stub
 * defaults to a server that advertises no extensions.
 */
function makeSource(client: unknown, era: "legacy" | "modern" = "legacy"): McpSource {
  const source = new McpSource(
    "stub",
    { type: "remote", url: new URL("http://localhost:0/mcp") },
    new NoopEventSink(),
  );
  const stub =
    client && typeof client === "object" && !("getServerCapabilities" in client)
      ? { getServerCapabilities: () => ({}), ...client }
      : client;
  const internals = source as unknown as { client: unknown; protocolEra: string };
  internals.client = stub;
  internals.protocolEra = era;
  return source;
}

/** A JSON-RPC error with `code`, as the SDK surfaces a server's error answer. */
function rpcError(code: number): Error & { code: number } {
  return Object.assign(new Error(`rpc ${code}`), { code });
}

describe("McpSource skills extension", () => {
  it("asks a declaring server on either era, and an undeclared one only on the 2025 era", () => {
    const declares = { getServerCapabilities: () => ({ extensions: { [SKILLS_EXTENSION_ID]: {} } }) };
    expect(makeSource(declares, "modern").skillsDiscovery()).toBe("declared");
    expect(makeSource(declares, "legacy").skillsDiscovery()).toBe("declared");
    expect(makeSource({}, "modern").skillsDiscovery()).toBe("none");
    expect(makeSource({}, "legacy").skillsDiscovery()).toBe("probe");
  });

  it("never asks an undeclared in-process source, the platform's own app", async () => {
    const source = await makeInProcessSource("platform-app", []);
    try {
      expect(source.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
      expect(source.skillsDiscovery()).toBe("none");
      const client = source.getClient();
      const request = client ? spyOn(client, "request") : undefined;
      // Discovery's gate: the runtime calls `listSkills` only when this is not `none`.
      if (source.skillsDiscovery() !== "none") await source.listSkills();
      expect(request?.mock.calls.some(([r]) => (r as { method?: string }).method === "skills/list")).toBe(
        false,
      );
    } finally {
      await source.stop();
    }
  });

  it("reads -32601 on a 2025-era probe as a complete listing of nothing", async () => {
    const source = makeSource({
      request: async () => {
        throw rpcError(-32601);
      },
    });
    expect(await source.listSkills()).toEqual({ entries: [], ok: true, truncated: false });
  });

  it("reads -32601 from a server that declared the extension as a failure", async () => {
    const source = makeSource({
      getServerCapabilities: () => ({ extensions: { [SKILLS_EXTENSION_ID]: {} } }),
      request: async () => {
        throw rpcError(-32601);
      },
    });
    expect(await source.listSkills()).toEqual({ entries: [], ok: false, truncated: false });
  });

  it("follows skills/list pagination", async () => {
    const methods: string[] = [];
    const source = makeSource({
      request: async (req: { method: string; params: { cursor?: string } }) => {
        methods.push(req.method);
        return req.params.cursor ? { skills: ["b"] } : { skills: ["a"], nextCursor: "p2" };
      },
    });
    expect(await source.listSkills()).toEqual({ entries: ["a", "b"], ok: true, truncated: false });
    expect(methods).toEqual(["skills/list", "skills/list"]);
  });

  it("reports a failed or capped enumeration as incomplete", async () => {
    const failing = makeSource({
      request: async () => {
        throw new Error("transport blip");
      },
    });
    expect(await failing.listSkills()).toEqual({ entries: [], ok: false, truncated: false });

    const endless = makeSource({ request: async () => ({ skills: ["x"], nextCursor: "more" }) });
    const out = await endless.listSkills();
    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(true);
  });
});
