import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../util/atomic-json.ts";
import type { RegistryConfig } from "./types.ts";

/**
 * Instance-level registry configuration. NimbleBrain is single-org per
 * instance, so the registries-enabled list lives in one place at the
 * work-dir root (alongside `nimblebrain.json`).
 *
 * Storage:
 *   <workDir>/registries.json
 *
 * Schema:
 *   { registries: RegistryConfig[] }
 *
 * On first read with no file present, the store seeds two defaults:
 *
 *   - curated  — the in-process curated catalog. Locked (operator
 *     can't disable or remove it).
 *   - mpak     — mpak.dev. Default enabled; operator can disable
 *     entirely or point at a different mpak instance.
 *
 * Atomic writes via tmp-rename so a crash mid-write doesn't leave a
 * half-flushed JSON in place.
 */

const FILE_NAME = "registries.json";

function defaultRegistries(): RegistryConfig[] {
  return [
    {
      id: "curated",
      name: "Curated services",
      type: "curated",
      enabled: true,
      locked: true,
    },
    {
      id: "mpak",
      name: "mpak.dev",
      type: "mpak",
      enabled: true,
      url: "https://mpak.dev",
    },
  ];
}

interface PersistedRecord {
  registries: RegistryConfig[];
}

export class RegistryStore {
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
    if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
  }

  /** Read all registries. Auto-seeds the file if absent. */
  async list(): Promise<RegistryConfig[]> {
    const record = await this.load();
    return record.registries;
  }

  /** Look up a single registry by id. */
  async get(id: string): Promise<RegistryConfig | null> {
    const all = await this.list();
    return all.find((r) => r.id === id) ?? null;
  }

  /**
   * Patch one registry. Returns the updated record. Locked registries
   * may have `enabled` updated only via the `force` escape hatch
   * (intentionally not exposed through the admin tool — kept here for
   * tests / future migration paths).
   */
  async update(
    id: string,
    patch: Partial<Pick<RegistryConfig, "enabled" | "url" | "name">>,
    opts: { force?: boolean } = {},
  ): Promise<RegistryConfig> {
    const record = await this.load();
    const idx = record.registries.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`Registry "${id}" not found`);
    const existing = record.registries[idx];
    if (existing === undefined) {
      throw new Error(`Registry "${id}" not found`);
    }
    if (existing.locked && !opts.force) {
      // Lock applies to enabled+removal, not display name / URL — the
      // operator can still rename a locked registry. Reject only the
      // disable path here.
      if (patch.enabled === false) {
        throw new Error(`Registry "${id}" is locked and cannot be disabled.`);
      }
    }
    const next: RegistryConfig = { ...existing, ...patch };
    record.registries[idx] = next;
    await this.save(record);
    return next;
  }

  // ── internals ───────────────────────────────────────────────────

  private filePath(): string {
    return join(this.workDir, FILE_NAME);
  }

  private async load(): Promise<PersistedRecord> {
    const path = this.filePath();
    try {
      const content = await readFile(path, "utf-8");
      const parsed = JSON.parse(content) as PersistedRecord;
      if (!Array.isArray(parsed?.registries)) {
        return { registries: defaultRegistries() };
      }
      // Ensure the locked curated registry can't be removed by hand-
      // editing the file — re-add it if missing.
      if (!parsed.registries.some((r) => r.id === "curated")) {
        parsed.registries.unshift(defaultRegistries()[0] as RegistryConfig);
        await this.save(parsed);
      }
      return parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const seeded: PersistedRecord = { registries: defaultRegistries() };
        await this.save(seeded);
        return seeded;
      }
      throw err;
    }
  }

  private async save(record: PersistedRecord): Promise<void> {
    await writeJsonAtomic(this.filePath(), record);
  }
}
