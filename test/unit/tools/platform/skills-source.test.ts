/**
 * Platform `skills` source contract tests.
 *
 * Verifies the source-level contract: factory returns a started McpSource;
 * tools/list surfaces exactly the four read tools; resources/list publishes
 * the Layer 1 vendored guide URI; tool descriptions are production-quality.
 *
 * Detailed handler behavior (filtering, dispatch, permissions) lives in
 * `skills-tools.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import { McpSource } from "../../../../src/tools/mcp-source.ts";
import {
  createSkillsSource,
  isTaskForbiddenSkillTool,
} from "../../../../src/tools/platform/skills.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";

// ── Fake Runtime ────────────────────────────────────────────────────────
//
// The scaffold-level contract tests never call any handler in earnest, so
// the runtime stub provides only the methods the handler skeleton invokes
// during dispatch (e.g. `getWorkDir` is read by `read` to compute allowed
// roots even on validation-rejection paths). Tests that exercise real
// handler logic live in `skills-tools.test.ts`.

class FakeRuntime {
  constructor(private workDir: string) {}
  getWorkDir(): string {
    return this.workDir;
  }
  getCurrentIdentity(): null {
    return null;
  }
  requireWorkspaceId(): never {
    throw new Error("no workspace");
  }
  getContextSkills(): never[] {
    return [];
  }
  getMatchableSkills(): never[] {
    return [];
  }
  loadConversationSkills(): never[] {
    return [];
  }
}

let workDir: string;
let source: McpSource | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "skills-src-contract-"));
});

afterEach(async () => {
  if (source) await source.stop();
  source = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

async function buildSource(): Promise<McpSource> {
  const runtime = new FakeRuntime(workDir);
  source = createSkillsSource(runtime as unknown as never, new NoopEventSink());
  await source.start();
  return source;
}

// ── Source factory ──────────────────────────────────────────────────────

describe("skills source — factory", () => {
  test("returns a started McpSource", async () => {
    const src = await buildSource();
    expect(src).toBeInstanceOf(McpSource);
    expect(src.getClient()).not.toBeNull();
  });
});

// ── Tools list ──────────────────────────────────────────────────────────

describe("skills source — tools list", () => {
  // Catalog activation is deliberately NOT here — it registers on the
  // system-tools source as `nb__use_skill` so it is kernel-direct. See
  // `createUseSkillToolDef` and `test/unit/tools/surfacing.test.ts`.
  test("exposes the read tools and the mutation tools", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "activate",
      "create",
      "deactivate",
      "delete",
      "history",
      "list",
      "loading_log",
      "read",
      "restore",
      "update",
    ]);
  });

  test("does NOT expose tools deferred to later phases", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    // Phase 4+ tools — author/commit_draft/lint/attribution land later.
    expect(names).not.toContain("author");
    expect(names).not.toContain("commit_draft");
    expect(names).not.toContain("lint");
    expect(names).not.toContain("attribution");
  });

  test("each tool has a non-trivial production-quality description", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const tools = await client.listTools();
    for (const t of tools.tools) {
      expect(t.description).toBeTruthy();
      expect((t.description ?? "").length).toBeGreaterThan(50);
    }
  });
});

// ── Schema rejection ────────────────────────────────────────────────────

describe("skills source — schema rejection", () => {
  test("read without id is rejected by schema validation", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "read", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

// ── Resources ───────────────────────────────────────────────────────────

describe("skills source — resources", () => {
  test("resources/list includes skill://skills/authoring-guide", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain("skill://skills/authoring-guide");
  });

  test("resources/read returns non-empty markdown for the authoring guide", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const data = await client.readResource({ uri: "skill://skills/authoring-guide" });
    const text = (data.contents?.[0]?.text as string | undefined) ?? "";
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    // Real Task 005 content begins with frontmatter (`---`); the placeholder
    // starts with `# Authoring Guide`. Accept either shape.
    expect(text.startsWith("#") || text.startsWith("---")).toBe(true);
  });

  test("authoring guide is served as text/markdown", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const data = await client.readResource({ uri: "skill://skills/authoring-guide" });
    expect(data.contents?.[0]?.mimeType).toBe("text/markdown");
  });
});

// ── Unattended-run wall ─────────────────────────────────────────────────
//
// A skill is durable guidance the runtime composes into later prompts on its
// own. A task run ingests untrusted content with no human present, so it may
// read the catalog and report on it, but not write to it.

describe("skills source — unattended-run wall", () => {
  const MUTATIONS = ["create", "update", "delete", "activate", "deactivate", "restore"];
  const READS = ["list", "read", "history", "loading_log"];

  test("every tool is classified — a new one cannot be added without a decision", async () => {
    // The set below is the whole namespace. If a tool is added and not sorted
    // into reads or mutations, this fails rather than the tool silently
    // inheriting whichever default the author did not think about.
    const src = await buildSource();
    const names = (await src.getClient()!.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...MUTATIONS, ...READS].sort());
  });

  test("the predicate bars every mutation and no read", () => {
    for (const name of MUTATIONS) {
      expect(isTaskForbiddenSkillTool(`skills__${name}`)).toBe(true);
    }
    for (const name of READS) {
      expect(isTaskForbiddenSkillTool(`skills__${name}`)).toBe(false);
    }
  });

  test("the predicate fails CLOSED for a tool added to the namespace later", () => {
    // An allowlist, not a denylist: a mutation added tomorrow is barred by
    // default rather than silently reopening the vector.
    expect(isTaskForbiddenSkillTool("skills__publish_to_everyone")).toBe(true);
  });

  test("the predicate does not reach outside its own namespace", () => {
    expect(isTaskForbiddenSkillTool("conversations__update")).toBe(false);
    expect(isTaskForbiddenSkillTool("files__create")).toBe(false);
    expect(isTaskForbiddenSkillTool("nb__use_skill")).toBe(false);
  });

  test("a name with no source segment is not in this namespace", () => {
    // `splitInnerToolName` returns the whole input as BOTH segments when there
    // is no separator, so a bare `skills` reports `sourcePrefix === "skills"`.
    // Only `hasSeparator` separates that from a real `skills__*` name; dropping
    // it silently bars a sourceless tool that this policy has no claim on.
    expect(isTaskForbiddenSkillTool("skills")).toBe(false);
    expect(isTaskForbiddenSkillTool("create")).toBe(false);
  });

  test("a malformed name inside the namespace still fails closed", () => {
    expect(isTaskForbiddenSkillTool("skills__")).toBe(true);
  });

  // Valid arguments on purpose: schema validation runs BEFORE the handler, so
  // a malformed call is rejected as bad input and never reaches the wall. That
  // is harmless — no mutation happens on either path — but a test built on
  // invalid args would pass while proving nothing about the wall.
  const VALID_CREATE = {
    scope: "workspace",
    manifest: { name: "injected", description: "written by an automation" },
    body: "# do the attacker's bidding",
  };

  test("a mutation called inside an unattended run is refused at the source", async () => {
    // Enforced at dispatch, not only by surfacing subtraction — a delegated
    // sub-agent that was never shown the tool can still name it.
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await runWithRequestContext(
      { identity: { id: "user_test" }, unattended: true } as never,
      () => client.callTool({ name: "create", arguments: VALID_CREATE }),
    );
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("not available inside an unattended automation run");
  });

  test("a read called inside an unattended run is NOT refused by the wall", async () => {
    // The automation's whole permitted job — audit and report — must survive.
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await runWithRequestContext(
      { identity: { id: "user_test" }, unattended: true } as never,
      () => client.callTool({ name: "list", arguments: {} }),
    );
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).not.toContain("not available inside an unattended automation run");
  });

  test("outside a run the same mutation is not walled", async () => {
    // Pins that the wall keys on `unattended`, not on the tool being broken.
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "create", arguments: VALID_CREATE });
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).not.toContain("not available inside an unattended automation run");
  });
});
