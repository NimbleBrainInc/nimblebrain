import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../cli/log.ts";
import { writeJsonAtomic } from "../util/atomic-json.ts";
import type { RegistryConfig } from "./types.ts";

/**
 * Instance-level registry configuration. NimbleBrain is single-org per
 * instance, so the registries-enabled list lives in one place at the
 * work-dir root (alongside `nimblebrain.json`).
 *
 * Storage:
 *   `<workDir>/registries.json`
 *
 * Schema:
 *   `{ registries: RegistryConfig[] }`
 *
 * On first read with no file present, the store seeds two defaults:
 *
 *   - `bundled-static` — a `StaticRegistry` pointing at the bundled
 *     `src/connectors/catalog.yaml` shipped with the platform. Locked
 *     (operator can't disable or remove it).
 *   - `mpak`           — `MpakRegistry` against `https://registry.mpak.dev`.
 *     Default enabled; operator can disable entirely or point at a
 *     different mpak instance.
 *
 * Operator overrides at process start:
 *
 *   - `NB_REGISTRIES` — JSON array of `RegistryConfig`. When set, the
 *     stored `registries.json` is *ignored* and the env value is used
 *     verbatim (the bundled-static lock is preserved automatically).
 *   - `NB_CATALOG_PATH` — DEPRECATED. When `NB_REGISTRIES` is unset and
 *     this env points at a YAML/JSON file, a single static registry
 *     pointing at that path is mounted. Logs a deprecation warning.
 *
 * Atomic writes via tmp-rename so a crash mid-write doesn't leave a
 * half-flushed JSON in place.
 */

const FILE_NAME = "registries.json";

/** Absolute path to the bundled curated catalog YAML. */
export const BUNDLED_STATIC_CATALOG_PATH = join(
  import.meta.dir,
  "..",
  "connectors",
  "catalog.yaml",
);

const BUNDLED_STATIC_ID = "bundled-static";
const MPAK_ID = "mpak";

/**
 * Look up a seeded registry by id. Used by env-override paths so we
 * don't pin behavior to the array order in `defaultRegistries()` —
 * adding a new seeded registry above mpak would otherwise silently
 * swap which entry is "the mpak default" or "the locked bundled-static."
 */
function defaultRegistryById(id: string): RegistryConfig {
  const found = defaultRegistries().find((r) => r.id === id);
  if (!found) {
    throw new Error(`[registries] internal: missing seeded registry "${id}"`);
  }
  return found;
}

function defaultRegistries(): RegistryConfig[] {
  return [
    {
      id: BUNDLED_STATIC_ID,
      name: "Curated services",
      type: "static",
      enabled: true,
      locked: true,
      url: BUNDLED_STATIC_CATALOG_PATH,
    },
    // No `url` — the mpak SDK owns its default registry host. Operators
    // self-hosting a private mpak instance set `url` via the admin UI
    // or `NB_REGISTRIES`; otherwise the SDK's built-in default is used.
    {
      id: MPAK_ID,
      name: "mpak.dev",
      type: "mpak",
      enabled: true,
    },
  ];
}

interface PersistedRecord {
  registries: RegistryConfig[];
}

export class RegistryStore {
  private workDir: string;
  /** Cached env-derived overrides. Computed once at construction. */
  private envOverride: RegistryConfig[] | null;

  constructor(workDir: string) {
    this.workDir = workDir;
    if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
    this.envOverride = resolveEnvOverride();
  }

  /** Read all registries. Auto-seeds the file if absent. */
  async list(): Promise<RegistryConfig[]> {
    if (this.envOverride) return this.envOverride;
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
   *
   * When env overrides are active, persistent mutation is rejected —
   * the env value is the source of truth and we don't want to silently
   * shadow it with a `registries.json` write.
   */
  async update(
    id: string,
    patch: Partial<Pick<RegistryConfig, "enabled" | "url" | "name">>,
    opts: { force?: boolean } = {},
  ): Promise<RegistryConfig> {
    if (this.envOverride) {
      throw new Error(
        `Registry mutation refused: NB_REGISTRIES is set; remove the env var before editing registries.`,
      );
    }
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
      // Ensure the locked bundled-static registry can't be removed by
      // hand-editing the file — re-add it if missing.
      if (!parsed.registries.some((r) => r.id === BUNDLED_STATIC_ID)) {
        parsed.registries.unshift(defaultRegistryById(BUNDLED_STATIC_ID));
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

/**
 * Resolve env-driven registry overrides, with a deprecation warning
 * for the legacy `NB_CATALOG_PATH` shape. Returns null when no env
 * override is in effect.
 */
function resolveEnvOverride(): RegistryConfig[] | null {
  const raw = process.env.NB_REGISTRIES;
  if (raw && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        log.warn(`[registries] NB_REGISTRIES did not parse as a JSON array — ignored`);
        return null;
      }
      const validated = validateRegistryConfigs(parsed, "NB_REGISTRIES");
      // Always re-pin the bundled static registry as locked + first so
      // operator overrides can add registries without accidentally
      // dropping the platform default.
      const bundled = defaultRegistryById(BUNDLED_STATIC_ID);
      const withoutBundled = validated.filter((r) => r.id !== bundled.id);
      return [bundled, ...withoutBundled];
    } catch (err) {
      log.warn(
        `[registries] NB_REGISTRIES parse error: ${err instanceof Error ? err.message : String(err)} — ignored`,
      );
      return null;
    }
  }
  const legacy = process.env.NB_CATALOG_PATH;
  if (legacy && legacy.trim().length > 0) {
    log.warn(
      `[registries] NB_CATALOG_PATH is deprecated; switch to NB_REGISTRIES with a JSON array of {id,name,type,url}.`,
    );
    return [
      defaultRegistryById(BUNDLED_STATIC_ID),
      {
        id: "operator-static",
        name: "Operator catalog",
        type: "static",
        enabled: true,
        url: legacy.trim(),
      },
      defaultRegistryById(MPAK_ID),
    ];
  }
  return null;
}

/**
 * Filter raw env input down to well-formed `RegistryConfig` entries.
 * Drops anything missing required fields; logs each rejection so an
 * operator with a typo gets a clear message at startup.
 */
function validateRegistryConfigs(raw: unknown[], source: string): RegistryConfig[] {
  const out: RegistryConfig[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as Partial<RegistryConfig> | undefined;
    const tag = `${source}[${i}${c?.id ? `:${c.id}` : ""}]`;
    if (!c || typeof c !== "object") {
      log.warn(`[registries] ${tag} dropped — not an object`);
      continue;
    }
    if (typeof c.id !== "string" || c.id.length === 0) {
      log.warn(`[registries] ${tag} dropped — id missing`);
      continue;
    }
    if (seen.has(c.id)) {
      log.warn(`[registries] ${tag} dropped — duplicate id`);
      continue;
    }
    if (typeof c.name !== "string" || c.name.length === 0) {
      log.warn(`[registries] ${tag} dropped — name missing`);
      continue;
    }
    if (c.type !== "static" && c.type !== "mpak" && c.type !== "mcp" && c.type !== "custom-url") {
      log.warn(`[registries] ${tag} dropped — type must be static|mpak|mcp|custom-url`);
      continue;
    }
    let scopes: string[] | undefined;
    if (c.scopes !== undefined) {
      if (
        !Array.isArray(c.scopes) ||
        !c.scopes.every((s) => typeof s === "string" && s.length > 0)
      ) {
        log.warn(`[registries] ${tag} dropped — scopes must be an array of non-empty strings`);
        continue;
      }
      scopes = c.scopes;
    }
    seen.add(c.id);
    out.push({
      id: c.id,
      name: c.name,
      type: c.type,
      enabled: c.enabled !== false,
      ...(typeof c.url === "string" ? { url: c.url } : {}),
      ...(scopes ? { scopes } : {}),
      ...(c.locked === true ? { locked: true } : {}),
    });
  }
  return out;
}
