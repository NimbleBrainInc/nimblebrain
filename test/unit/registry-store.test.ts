import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../../src/observability/log.ts";
import {
  RegistryStore,
  warnIfCuratedCatalogEmpty,
} from "../../src/registries/registry-store.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";

/** Run `fn` with NB_CURATED_CATALOG_DIR set, restoring the prior value. */
async function withCuratedDir(dir: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.NB_CURATED_CATALOG_DIR;
  process.env.NB_CURATED_CATALOG_DIR = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.NB_CURATED_CATALOG_DIR;
    else process.env.NB_CURATED_CATALOG_DIR = prev;
  }
}

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
      // Defaults to the minimal in-image curated catalog directory.
      expect(bundled?.url).toMatch(/connectors\/curated$/);
      expect(mpak?.enabled).toBe(true);
      // Seeded mpak row carries no `url` — the SDK owns its default host.
      expect(mpak?.url).toBeUndefined();
      // Narrow-by-default: first install sees only NimbleBrain-curated
      // bundles. Operators broaden by editing the row.
      expect(mpak?.scopes).toEqual(["nimblebraininc"]);
    } finally {
      cleanup();
    }
  });

  test("curated registry url honors NB_CURATED_CATALOG_DIR override", async () => {
    await withCuratedDir("/config/connectors", async () => {
      const { store, cleanup } = freshStore();
      try {
        const bundled = (await store.list()).find((r) => r.id === "bundled-static");
        expect(bundled?.url).toBe("/config/connectors");
      } finally {
        cleanup();
      }
    });
  });

  test("blank NB_CURATED_CATALOG_DIR falls back to the in-image default", async () => {
    await withCuratedDir("   ", async () => {
      const { store, cleanup } = freshStore();
      try {
        const bundled = (await store.list()).find((r) => r.id === "bundled-static");
        expect(bundled?.url).toMatch(/connectors\/curated$/);
      } finally {
        cleanup();
      }
    });
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

  /** Write a registries.json seeding bundled-static at `url` (+ mpak). */
  function seedRegistriesJson(dir: string, url: string): void {
    writeFileSync(
      join(dir, "registries.json"),
      JSON.stringify({
        registries: [
          {
            id: "bundled-static",
            name: "Curated services",
            type: "static",
            enabled: true,
            locked: true,
            url,
          },
          { id: "mpak", name: "mpak.dev", type: "mpak", enabled: true },
        ],
      }),
    );
  }

  test("resolves a broken persisted curated url to the in-image default (in-memory, no clobber)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-regstore-"));
    try {
      // A tenant seeded by an older image: registries.json persists a
      // catalog path the new image no longer ships.
      const stale = "/app/src/connectors/catalog.yaml";
      seedRegistriesJson(dir, stale);
      const store = new RegistryStore(dir);
      const bundled = (await store.list()).find((r) => r.id === "bundled-static");
      // Read-time resolution falls back to the in-image example.
      expect(bundled?.url).toMatch(/connectors\/curated$/);
      // Disk is NOT rewritten — the resolution is in-memory only, so a
      // transient miss can't permanently overwrite the persisted value.
      const onDisk = JSON.parse(readFileSync(join(dir, "registries.json"), "utf-8")) as {
        registries: Array<{ id: string; url?: string }>;
      };
      expect(onDisk.registries.find((r) => r.id === "bundled-static")?.url).toBe(stale);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves a valid hand-edited curated url (#247 direct-edit lever)", async () => {
    // An operator points the curated registry at their own catalog dir
    // by editing registries.json directly. With no env override, a path
    // that still resolves must be honored, not replaced.
    const custom = mkdtempSync(join(tmpdir(), "nb-custom-catalog-"));
    writeFileSync(join(custom, "curated.yaml"), "servers: []\n");
    const dir = mkdtempSync(join(tmpdir(), "nb-regstore-"));
    try {
      seedRegistriesJson(dir, custom);
      const store = new RegistryStore(dir);
      const bundled = (await store.list()).find((r) => r.id === "bundled-static");
      expect(bundled?.url).toBe(custom);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(custom, { recursive: true, force: true });
    }
  });

  test("NB_CURATED_CATALOG_DIR overrides even a valid persisted url (env wins)", async () => {
    // The Phase-2 deploy lever is authoritative: it must win over a
    // persisted hand-edit, the same way NB_REGISTRIES beats disk.
    const custom = mkdtempSync(join(tmpdir(), "nb-custom-catalog-"));
    writeFileSync(join(custom, "curated.yaml"), "servers: []\n");
    await withCuratedDir("/config/connectors", async () => {
      const dir = mkdtempSync(join(tmpdir(), "nb-regstore-"));
      try {
        seedRegistriesJson(dir, custom); // valid, but env must still win
        const store = new RegistryStore(dir);
        const bundled = (await store.list()).find((r) => r.id === "bundled-static");
        expect(bundled?.url).toBe("/config/connectors");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    rmSync(custom, { recursive: true, force: true });
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

describe("warnIfCuratedCatalogEmpty", () => {
  test("warns when the curated catalog resolves to zero entries", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nb-empty-catalog-"));
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await withCuratedDir(empty, async () => {
        const { store, cleanup } = freshStore();
        try {
          await warnIfCuratedCatalogEmpty(store);
          expect(warn).toHaveBeenCalled();
          expect(warn.mock.calls.some((c) => String(c[0]).includes("0 entries"))).toBe(true);
        } finally {
          cleanup();
        }
      });
    } finally {
      warn.mockRestore();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("stays quiet when the curated catalog has entries", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await withCuratedDir(CONNECTOR_FIXTURE_DIR, async () => {
        const { store, cleanup } = freshStore();
        try {
          await warnIfCuratedCatalogEmpty(store);
          expect(warn.mock.calls.some((c) => String(c[0]).includes("0 entries"))).toBe(false);
        } finally {
          cleanup();
        }
      });
    } finally {
      warn.mockRestore();
    }
  });
});
