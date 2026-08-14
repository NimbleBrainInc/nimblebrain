/**
 * `skills__update` body intent, and the history/restore pair, through the real
 * tool surface.
 *
 * The unit suite (`test/unit/skills/versions.test.ts`) covers the primitives.
 * This pins the TOOL contract, which is where the data loss actually happened:
 * an agent asked to "add a rule" called update with only the new section, the
 * whole body was replaced, and the `_versions/` snapshot that held the original
 * could not be listed or read by any tool the agent or operator had.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { extractText } from "../../src/engine/content-helpers.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-skill-history-${Date.now()}`);
let runtime: Runtime;

const ORIGINAL = "## Rule one\n\nAlways cite a source.";
const ADDITION = "## Rule two\n\nNever invent a number.";

interface Called {
  content: string;
  isError: boolean;
  structured: Record<string, unknown>;
}

async function callTool(name: string, input: Record<string, unknown>): Promise<Called> {
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  const result = await runWithRequestContext(
    { identity: null, workspaceId: TEST_WORKSPACE_ID },
    () => registry.execute({ id: `t-${name}-${Math.random()}`, name, input }),
  );
  return {
    content: extractText(result.content),
    isError: result.isError ?? false,
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
  };
}

/** Create a fresh skill and return its id (filesystem path). */
async function createSkill(name: string): Promise<string> {
  const res = await callTool("skills__create", {
    scope: "workspace",
    manifest: { name, description: "House rules", loadingStrategy: "always" },
    body: ORIGINAL,
  });
  expect(res.isError).toBe(false);
  return String(res.structured.id);
}

beforeAll(async () => {
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("skills__update body intent", () => {
  it("refuses a body with no body_mode, and changes nothing", async () => {
    const id = await createSkill("intent-required");
    const res = await callTool("skills__update", { id, body: ADDITION });

    expect(res.isError).toBe(true);
    expect(res.content).toContain("body_mode");
    // The refusal is the point: the original survives untouched.
    const read = await callTool("skills__read", { id });
    expect(read.content).toContain("Always cite a source.");
    expect(read.content).not.toContain("Never invent a number.");
  });

  it("append adds the rule and keeps everything already there", async () => {
    const id = await createSkill("append-keeps");
    const res = await callTool("skills__update", { id, body: ADDITION, body_mode: "append" });
    expect(res.isError).toBe(false);

    const read = await callTool("skills__read", { id });
    expect(read.content).toContain("Always cite a source.");
    expect(read.content).toContain("Never invent a number.");
  });

  it("replace overwrites, but only when explicitly asked", async () => {
    const id = await createSkill("replace-explicit");
    const res = await callTool("skills__update", { id, body: ADDITION, body_mode: "replace" });
    expect(res.isError).toBe(false);

    const read = await callTool("skills__read", { id });
    expect(read.content).not.toContain("Always cite a source.");
    expect(read.content).toContain("Never invent a number.");
  });

  it("a manifest-only patch still needs no body_mode", async () => {
    const id = await createSkill("manifest-only");
    const res = await callTool("skills__update", { id, manifest: { description: "Renamed" } });
    expect(res.isError).toBe(false);

    const read = await callTool("skills__read", { id });
    expect(read.content).toContain("Always cite a source.");
  });
});

describe("skills__history and skills__restore", () => {
  it("history is empty before any update, then lists each snapshot", async () => {
    const id = await createSkill("history-grows");

    const before = await callTool("skills__history", { id });
    expect(before.isError).toBe(false);
    expect((before.structured.versions as unknown[]).length).toBe(0);

    await callTool("skills__update", { id, body: ADDITION, body_mode: "append" });
    const after = await callTool("skills__history", { id });
    expect((after.structured.versions as unknown[]).length).toBe(1);
  });

  it("a listed version is readable through skills__read", async () => {
    const id = await createSkill("version-readable");
    await callTool("skills__update", { id, body: "clobbered", body_mode: "replace" });

    const hist = await callTool("skills__history", { id });
    const version = (hist.structured.versions as Array<{ version: string }>)[0]?.version;
    expect(version).toBeTruthy();

    const snap = await callTool("skills__read", { id, version });
    expect(snap.isError).toBe(false);
    expect(snap.content).toContain("Always cite a source.");
    // The live file is still the clobbered one — reading history is not restoring.
    const live = await callTool("skills__read", { id });
    expect(live.content).not.toContain("Always cite a source.");
  });

  it("restores content a replace discarded — the incident, recovered", async () => {
    const id = await createSkill("restore-incident");
    // The destructive edit: agent sends only the new rule, with replace.
    await callTool("skills__update", { id, body: ADDITION, body_mode: "replace" });
    expect((await callTool("skills__read", { id })).content).not.toContain("Always cite a source.");

    const hist = await callTool("skills__history", { id });
    const version = (hist.structured.versions as Array<{ version: string }>)[0]?.version;
    const res = await callTool("skills__restore", { id, version });
    expect(res.isError).toBe(false);

    const read = await callTool("skills__read", { id });
    expect(read.content).toContain("Always cite a source.");
  });

  it("a restore is itself undoable — it snapshots the version it replaced", async () => {
    const id = await createSkill("restore-undoable");
    await callTool("skills__update", { id, body: ADDITION, body_mode: "replace" });

    const hist1 = await callTool("skills__history", { id });
    const v1 = (hist1.structured.versions as Array<{ version: string }>)[0]?.version;
    await callTool("skills__restore", { id, version: v1 });

    const hist2 = await callTool("skills__history", { id });
    const versions = hist2.structured.versions as Array<{ version: string }>;
    expect(versions.length).toBe(2);

    // The newest snapshot holds what the restore overwrote (the clobbered body).
    const newest = await callTool("skills__read", { id, version: versions[0]?.version });
    expect(newest.content).toContain("Never invent a number.");
  });

  it("an unknown version is a clear error, not a silent no-op", async () => {
    const id = await createSkill("unknown-version");
    const res = await callTool("skills__restore", { id, version: "2026-01-01T00-00-00-000Z" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("skills__history");
  });
});

describe("snapshot paths are not live skills", () => {
  it("refuses to update or take history on a path inside _versions/", async () => {
    const id = await createSkill("no-recursion");
    await callTool("skills__update", { id, body: ADDITION, body_mode: "append" });

    const hist = await callTool("skills__history", { id });
    const version = (hist.structured.versions as Array<{ version: string }>)[0]?.version;
    const snapshotPath = join(
      id.slice(0, id.lastIndexOf("/")),
      "_versions",
      `no-recursion.${version}.md`,
    );

    for (const call of [
      callTool("skills__update", { id: snapshotPath, body: "x", body_mode: "replace" }),
      callTool("skills__history", { id: snapshotPath }),
      callTool("skills__restore", { id: snapshotPath, version }),
    ]) {
      const res = await call;
      expect(res.isError).toBe(true);
      expect(res.content).toContain("stored snapshot");
    }
  });
});

describe("version ids cannot address a file the gates did not check", () => {
  it("a traversing version reads nothing, even with a legitimate id", async () => {
    const victimId = await createSkill("traversal-victim");
    const attackerId = await createSkill("traversal-attacker");
    await callTool("skills__update", { id: attackerId, body: "x", body_mode: "append" });

    // Every gate the handler runs validates `id` — legitimately the caller's
    // own skill. Only the version id constrains which file is opened.
    //
    // The leading `./` matters: the filename is built as `<base>.<version>.md`,
    // so a version starting with `..` glues into the literal dirname
    // `<base>..` and escapes nothing. Two real `..` segments after that pop
    // `<base>..` and then `_versions/`, landing in the skills dir.
    const versionsDir = join(dirname(attackerId), "_versions");
    const traversal = `./../../${basename(victimId).replace(/\.md$/, "")}`;

    // Self-check: this string really does resolve onto the victim file, so the
    // test exercises a live escape rather than a construction that never left
    // the directory. Without it, a typo here reports a false green forever.
    const attackerBase = basename(attackerId).replace(/\.md$/, "");
    expect(join(versionsDir, `${attackerBase}.${traversal}.md`)).toBe(victimId);

    const read = await callTool("skills__read", { id: attackerId, version: traversal });
    expect(read.isError).toBe(true);
    expect(read.content).not.toContain("Always cite a source.");

    const restore = await callTool("skills__restore", { id: attackerId, version: traversal });
    expect(restore.isError).toBe(true);
  });

  it("skills__delete refuses a snapshot path like every other destructive tool", async () => {
    const id = await createSkill("delete-snapshot");
    await callTool("skills__update", { id, body: ADDITION, body_mode: "append" });
    const hist = await callTool("skills__history", { id });
    const version = (hist.structured.versions as Array<{ version: string }>)[0]?.version;
    const snapshotPath = join(
      id.slice(0, id.lastIndexOf("/")),
      "_versions",
      `delete-snapshot.${version}.md`,
    );

    const res = await callTool("skills__delete", { id: snapshotPath });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("stored snapshot");
    // The snapshot survives, and no nested _versions/ was created.
    const after = await callTool("skills__history", { id });
    expect((after.structured.versions as unknown[]).length).toBe(1);
  });
});
