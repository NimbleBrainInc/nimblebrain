/**
 * `StaticSource` reads `ServerDetail[]` from a YAML or JSON file on
 * disk. It's the curated-services source we ship with the platform
 * (Asana, Notion, Granola, etc. — `src/connectors/catalog.yaml`) and
 * any operator-override source mounted via `NB_REGISTRIES` with
 * `type: "static"`.
 *
 * The contract is just `fetch(): Promise<ServerDetail[]>`. Filtering,
 * projection, error aggregation, and lookup tables live in
 * `ConnectorDirectory` — this class is a pure file-to-validated-records
 * adapter. Re-reads on every call so operator edits to a mounted
 * ConfigMap take effect without a restart.
 *
 * Wire format is the upstream MCP registry's `ServerDetail` shape
 * (see `src/connectors/server-detail.ts`). Every entry is ajv-validated
 * before it leaves the source. Invalid entries are dropped with a
 * logged warning naming the source path and the entry name (or index,
 * when `name` is missing); the surviving subset flows up.
 *
 * Top-level YAML/JSON shape:
 *
 *   YAML:  { servers: [ ServerDetail, ... ] }
 *   JSON:  { servers: [ ServerDetail, ... ] }
 *
 * Bare-array JSON (`[ ServerDetail, ... ]`) is also accepted for
 * minimal override files.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { log } from "../cli/log.ts";
import { type ServerDetail, validateServerDetail } from "../connectors/server-detail.ts";
import type { ConnectorSource } from "./types.ts";

export class StaticSource implements ConnectorSource {
  /**
   * @param id Stable source id (from `RegistryConfig.id`) — used by
   *   the directory in error-tagged log lines.
   * @param path Absolute path to the YAML/JSON file holding the
   *   `ServerDetail[]`. Read on every `fetch()` call so operator
   *   edits to a mounted ConfigMap take effect without a restart.
   */
  constructor(
    public readonly id: string,
    private readonly path: string,
  ) {}

  async fetch(): Promise<ServerDetail[]> {
    return readStaticServers(this.path);
  }
}

/**
 * Load a `ServerDetail[]` from the given YAML or JSON file. Returns
 * the validated subset — invalid entries are dropped with a logged
 * warning. Unreadable / unparseable files return an empty array
 * (caller logs the failure inline).
 */
export function readStaticServers(path: string): ServerDetail[] {
  if (!existsSync(path)) {
    log.warn(`[static-source] ${path}: file not found — returning empty`);
    return [];
  }
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    log.warn(
      `[static-source] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  let parsed: unknown;
  try {
    const ext = extname(path).toLowerCase();
    if (ext === ".yaml" || ext === ".yml") {
      parsed = Bun.YAML.parse(text);
    } else {
      parsed = JSON.parse(text);
    }
  } catch (err) {
    log.warn(
      `[static-source] failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  return validateStaticServers(parsed, path);
}

/**
 * Validate a parsed candidate. Accepts:
 *   - `{ servers: [ ... ] }`              (canonical YAML/JSON shape)
 *   - `[ ... ]`                            (bare-array convenience shape)
 *
 * Returns only the entries that pass the upstream `ServerDetail` ajv
 * schema and the platform's defense-in-depth safety checks.
 */
export function validateStaticServers(parsed: unknown, source: string): ServerDetail[] {
  let raw: unknown[];
  if (Array.isArray(parsed)) {
    raw = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { servers?: unknown }).servers)
  ) {
    raw = (parsed as { servers: unknown[] }).servers;
  } else {
    log.warn(`[static-source] ${source} did not yield a top-level 'servers' list or bare array`);
    return [];
  }

  const out: ServerDetail[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const candidate = raw[i];
    const name = candidateName(candidate);
    const tag = `${source}[${i}${name ? `:${name}` : ""}]`;
    const result = validateServerDetail(candidate);
    if (!result.valid) {
      log.warn(
        `[static-source] ${tag} dropped — invalid ServerDetail: ${result.errors.join("; ")}`,
      );
      continue;
    }
    const detail = candidate as ServerDetail;
    if (seenNames.has(detail.name)) {
      log.warn(`[static-source] ${tag} dropped — duplicate name "${detail.name}"`);
      continue;
    }
    // Defense-in-depth (URL scheme allowlist + reserved OAuth params)
    // runs uniformly at the directory boundary in
    // `validateServerDetailSafety` — every source is scrubbed there
    // regardless of provenance, so non-curated mpak entries get the
    // same protection static does.
    seenNames.add(detail.name);
    out.push(detail);
  }
  return out;
}

function candidateName(c: unknown): string | undefined {
  if (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string") {
    return (c as { name: string }).name;
  }
  return undefined;
}
