import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryStore } from "../../src/registries/registry-store.ts";

function freshStore(): { store: RegistryStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nb-regstore-"));
  const store = new RegistryStore(dir);
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("RegistryStore", () => {
  test("seeds bundled-static + mpak defaults on first read", async () => {
    const { store, cleanup } = freshStore();
    try {
      const all = await store.list();
      expect(all.length).toBe(2);
      const bundled = all.find((r) => r.id === "bundled-static");
      const mpak = all.find((r) => r.id === "mpak");
      expect(bundled?.enabled).toBe(true);
      expect(bundled?.locked).toBe(true);
      expect(bundled?.type).toBe("static");
      expect(bundled?.url).toMatch(/connectors\/catalog\.yaml$/);
      expect(mpak?.enabled).toBe(true);
      expect(mpak?.url).toBe("https://registry.mpak.dev");
    } finally {
      cleanup();
    }
  });

  test("persists changes across instances (file-backed)", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      await store.update("mpak", { enabled: false });
      const second = new RegistryStore(dir);
      const all = await second.list();
      expect(all.find((r) => r.id === "mpak")?.enabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("locked registry refuses to be disabled without force", async () => {
    const { store, cleanup } = freshStore();
    try {
      await expect(store.update("bundled-static", { enabled: false })).rejects.toThrow(/locked/i);
      const all = await store.list();
      expect(all.find((r) => r.id === "bundled-static")?.enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("locked registry can still be renamed (lock applies to disable only)", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.update("bundled-static", { name: "Custom curated" });
      const r = await store.get("bundled-static");
      expect(r?.name).toBe("Custom curated");
    } finally {
      cleanup();
    }
  });

  test("unknown id throws", async () => {
    const { store, cleanup } = freshStore();
    try {
      await expect(store.update("nonexistent", { enabled: true })).rejects.toThrow(/not found/i);
    } finally {
      cleanup();
    }
  });

  test("auto-restores bundled-static registry if hand-edited out of the file", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      // First read seeds the file.
      await store.list();
      // Hand-edit the file to remove the bundled-static entry (simulating
      // operator mistake or a botched migration). Next read should restore it.
      const path = join(dir, "registries.json");
      const content = JSON.parse(readFileSync(path, "utf-8")) as {
        registries: Array<{ id: string }>;
      };
      content.registries = content.registries.filter((r) => r.id !== "bundled-static");
      Bun.write(path, JSON.stringify(content));
      // New store instance reads + auto-restores.
      const second = new RegistryStore(dir);
      const all = await second.list();
      expect(all.find((r) => r.id === "bundled-static")).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("creates the file on first write (no race with seed)", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      await store.list();
      expect(existsSync(join(dir, "registries.json"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
