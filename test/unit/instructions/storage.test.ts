/**
 * `InstructionsStore` contract tests.
 *
 * Two scopes only — `org` and `workspace`. Per-connector instructions are
 * NOT platform-owned (connectors handle their own storage and publish a
 * `<sourceName>://instructions` resource); this store is just for the
 * cross-cutting platform overlays.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstructionsStore, MAX_INSTRUCTIONS_CHARS } from "../../../src/instructions/index.ts";
import { seedWorkspaceRoot } from "../../helpers/test-workspace.ts";

let workDir: string;
let store: InstructionsStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "instructions-test-"));
  seedWorkspaceRoot(workDir, "ws_00079598e311c160");
  seedWorkspaceRoot(workDir, "ws_002afe1142297ff4");
  seedWorkspaceRoot(workDir, "ws_004c451501a4ba5e");
  store = new InstructionsStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("InstructionsStore — round-trip", () => {
  test("workspace scope: write, read, meta records timestamp + author", async () => {
    const result = await store.write({
      wsId: "ws_002afe1142297ff4",
      text: "Always cite sources.",
      updatedBy: "ui",
    });

    expect(typeof result.updated_at).toBe("string");
    expect(Number.isFinite(Date.parse(result.updated_at))).toBe(true);

    const body = await store.read({ wsId: "ws_002afe1142297ff4" });
    expect(body).toBe("Always cite sources.");

    const meta = await store.readMeta({ wsId: "ws_002afe1142297ff4" });
    expect(meta).not.toBeNull();
    expect(meta?.updated_at).toBe(result.updated_at);
    expect(meta?.updated_by).toBe("ui");
  });
});

describe("InstructionsStore — missing files", () => {
  test("read returns empty string when no file exists", async () => {
    expect(await store.read({ wsId: "ws_002afe1142297ff4" })).toBe("");
  });

  test("readMeta returns null when no meta file exists", async () => {
    expect(await store.readMeta({ wsId: "ws_002afe1142297ff4" })).toBeNull();
  });
});

describe("InstructionsStore — empty text clears", () => {
  test("after write({ text: '' }), read returns '' AND files no longer exist", async () => {
    await store.write({
      wsId: "ws_002afe1142297ff4",
      text: "first body",
      updatedBy: "ui",
    });
    const filePath = join(workDir, "workspaces", "ws_002afe1142297ff4", "instructions.md");
    const metaPath = join(workDir, "workspaces", "ws_002afe1142297ff4", "instructions.meta.json");
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);

    await store.write({ wsId: "ws_002afe1142297ff4", text: "", updatedBy: "agent" });

    expect(await store.read({ wsId: "ws_002afe1142297ff4" })).toBe("");
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(metaPath)).toBe(false);
  });

  test("clearing a never-written file is a no-op (does not throw)", async () => {
    await expect(
      store.write({ wsId: "ws_004c451501a4ba5e", text: "", updatedBy: "agent" }),
    ).resolves.toEqual(expect.objectContaining({ updated_at: expect.any(String) }));
  });
});

describe("InstructionsStore — length cap", () => {
  test("write of exactly the character limit is accepted", async () => {
    const body = "x".repeat(MAX_INSTRUCTIONS_CHARS);
    await store.write({ wsId: "ws_002afe1142297ff4", text: body, updatedBy: "ui" });
    expect(await store.read({ wsId: "ws_002afe1142297ff4" })).toBe(body);
  });

  test("write one character over the limit rejects", async () => {
    const body = "x".repeat(MAX_INSTRUCTIONS_CHARS + 1);
    await expect(
      store.write({ wsId: "ws_002afe1142297ff4", text: body, updatedBy: "ui" }),
    ).rejects.toThrow(/8192/);
  });

  test("the limit counts characters, not UTF-8 bytes or UTF-16 units", async () => {
    // "🙂" is 4 bytes in UTF-8 and 2 UTF-16 units, but one character.
    const atLimit = "🙂".repeat(MAX_INSTRUCTIONS_CHARS);
    await store.write({ wsId: "ws_002afe1142297ff4", text: atLimit, updatedBy: "ui" });
    expect(await store.read({ wsId: "ws_002afe1142297ff4" })).toBe(atLimit);
    await expect(
      store.write({ wsId: "ws_002afe1142297ff4", text: `${atLimit}🙂`, updatedBy: "ui" }),
    ).rejects.toThrow(/8192/);
  });
});

describe("InstructionsStore — path validation", () => {
  test("rejects wsId containing '..'", async () => {
    await expect(store.write({ wsId: "ws_../evil", text: "x", updatedBy: "ui" })).rejects.toThrow();
    await expect(store.read({ wsId: "ws_../evil" })).rejects.toThrow();
  });

  test("rejects wsId starting with '/'", async () => {
    await expect(
      store.write({ wsId: "/etc/passwd", text: "x", updatedBy: "ui" }),
    ).rejects.toThrow();
  });

  test("rejects null byte in identifiers", async () => {
    await expect(
      store.write({ wsId: "ws_00079598e311c160\0b", text: "x", updatedBy: "ui" }),
    ).rejects.toThrow();
  });

  test("workspace scope without wsId rejects", async () => {
    await expect(
      // @ts-expect-error — intentionally wrong shape
      store.read({ scope: "workspace" }),
    ).rejects.toThrow();
  });
});

describe("InstructionsStore — overwrite semantics", () => {
  test("write twice updates the body and refreshes updated_at", async () => {
    const first = await store.write({
      wsId: "ws_002afe1142297ff4",
      text: "v1",
      updatedBy: "ui",
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.write({
      wsId: "ws_002afe1142297ff4",
      text: "v2",
      updatedBy: "agent",
    });

    expect(await store.read({ wsId: "ws_002afe1142297ff4" })).toBe("v2");
    expect(second.updated_at >= first.updated_at).toBe(true);
    expect((await store.readMeta({ wsId: "ws_002afe1142297ff4" }))?.updated_by).toBe("agent");
  });
});
