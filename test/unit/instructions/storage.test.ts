/**
 * `InstructionsStore` contract tests.
 *
 * Two scopes only — `org` and `workspace`. Per-bundle instructions are
 * NOT platform-owned (bundles handle their own storage and publish a
 * `<sourceName>://instructions` resource); this store is just for the
 * cross-cutting platform overlays.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InstructionsStore, MAX_INSTRUCTIONS_BYTES } from "../../../src/instructions/index.ts";

let workDir: string;
let store: InstructionsStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "instructions-test-"));
  store = new InstructionsStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("InstructionsStore — round-trip per scope", () => {
  test("workspace scope: write, read, meta records timestamp + author", async () => {
    const result = await store.write({
      scope: "workspace",
      wsId: "ws_demo",
      text: "Always cite sources.",
      updatedBy: "ui",
    });

    expect(typeof result.updated_at).toBe("string");
    expect(Number.isFinite(Date.parse(result.updated_at))).toBe(true);

    const body = await store.read({ scope: "workspace", wsId: "ws_demo" });
    expect(body).toBe("Always cite sources.");

    const meta = await store.readMeta({ scope: "workspace", wsId: "ws_demo" });
    expect(meta).not.toBeNull();
    expect(meta?.updated_at).toBe(result.updated_at);
    expect(meta?.updated_by).toBe("ui");
  });

  test("org scope: write, read, meta records updated_by=agent", async () => {
    await store.write({ scope: "org", text: "Org-wide policy.", updatedBy: "agent" });
    expect(await store.read({ scope: "org" })).toBe("Org-wide policy.");
    expect((await store.readMeta({ scope: "org" }))?.updated_by).toBe("agent");
  });
});

describe("InstructionsStore — missing files", () => {
  test("read returns empty string when no file exists", async () => {
    expect(await store.read({ scope: "workspace", wsId: "ws_demo" })).toBe("");
    expect(await store.read({ scope: "org" })).toBe("");
  });

  test("readMeta returns null when no meta file exists", async () => {
    expect(await store.readMeta({ scope: "workspace", wsId: "ws_demo" })).toBeNull();
    expect(await store.readMeta({ scope: "org" })).toBeNull();
  });
});

describe("InstructionsStore — empty text clears", () => {
  test("after write({ text: '' }), read returns '' AND files no longer exist", async () => {
    await store.write({
      scope: "workspace",
      wsId: "ws_demo",
      text: "first body",
      updatedBy: "ui",
    });
    const filePath = join(workDir, "workspaces", "ws_demo", "instructions.md");
    const metaPath = join(workDir, "workspaces", "ws_demo", "instructions.meta.json");
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);

    await store.write({ scope: "workspace", wsId: "ws_demo", text: "", updatedBy: "agent" });

    expect(await store.read({ scope: "workspace", wsId: "ws_demo" })).toBe("");
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(metaPath)).toBe(false);
  });

  test("clearing a never-written file is a no-op (does not throw)", async () => {
    await expect(
      store.write({ scope: "org", text: "", updatedBy: "agent" }),
    ).resolves.toEqual(expect.objectContaining({ updated_at: expect.any(String) }));
  });
});

describe("InstructionsStore — length cap", () => {
  test("write of 8 KB exactly is accepted", async () => {
    const body = "x".repeat(MAX_INSTRUCTIONS_BYTES);
    await store.write({ scope: "workspace", wsId: "ws_demo", text: body, updatedBy: "ui" });
    expect(await store.read({ scope: "workspace", wsId: "ws_demo" })).toBe(body);
  });

  test("write of 8 KB + 1 byte rejects", async () => {
    const body = "x".repeat(MAX_INSTRUCTIONS_BYTES + 1);
    await expect(
      store.write({ scope: "workspace", wsId: "ws_demo", text: body, updatedBy: "ui" }),
    ).rejects.toThrow(/8192/);
  });

  test("byte length is UTF-8, not character length (multibyte counted correctly)", async () => {
    // "🙂" is 4 bytes in UTF-8; 2049 of them is 8196 bytes — over cap.
    const body = "🙂".repeat(2049);
    await expect(
      store.write({ scope: "workspace", wsId: "ws_demo", text: body, updatedBy: "ui" }),
    ).rejects.toThrow();
  });
});

describe("InstructionsStore — path validation", () => {
  test("rejects wsId containing '..'", async () => {
    await expect(
      store.write({ scope: "workspace", wsId: "ws_../evil", text: "x", updatedBy: "ui" }),
    ).rejects.toThrow();
    await expect(
      store.read({ scope: "workspace", wsId: "ws_../evil" }),
    ).rejects.toThrow();
  });

  test("rejects wsId starting with '/'", async () => {
    await expect(
      store.write({ scope: "workspace", wsId: "/etc/passwd", text: "x", updatedBy: "ui" }),
    ).rejects.toThrow();
  });

  test("rejects null byte in identifiers", async () => {
    await expect(
      store.write({ scope: "workspace", wsId: "ws_a\0b", text: "x", updatedBy: "ui" }),
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
      scope: "workspace",
      wsId: "ws_demo",
      text: "v1",
      updatedBy: "ui",
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.write({
      scope: "workspace",
      wsId: "ws_demo",
      text: "v2",
      updatedBy: "agent",
    });

    expect(await store.read({ scope: "workspace", wsId: "ws_demo" })).toBe("v2");
    expect(second.updated_at >= first.updated_at).toBe(true);
    expect((await store.readMeta({ scope: "workspace", wsId: "ws_demo" }))?.updated_by).toBe(
      "agent",
    );
  });
});
