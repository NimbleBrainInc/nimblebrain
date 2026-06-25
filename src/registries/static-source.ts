/**
 * `StaticSource` reads `ServerDetail[]` from a YAML/JSON file — or a
 * directory of them — on disk. It's the curated-services source we
 * ship with the platform (the minimal in-image example under
 * `src/connectors/curated/`, overridden in deployments by a mounted
 * catalog directory) and any operator-override source mounted via
 * `NB_REGISTRIES` with `type: "static"`.
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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { type ServerDetail, validateServerDetail } from "../connectors/server-detail.ts";
import { log } from "../observability/log.ts";
import type { ConnectorSource } from "./types.ts";

export class StaticSource implements ConnectorSource {
  /**
   * @param id Stable source id (from `RegistryConfig.id`) — used by
   *   the directory in error-tagged log lines.
   * @param path Absolute path to a YAML/JSON file holding the
   *   `ServerDetail[]`, OR a directory of such files (every
   *   `*.yaml`/`*.yml`/`*.json` in it, read in sorted filename order
   *   and aggregated). Read on every `fetch()` call so operator edits
   *   to a mounted ConfigMap take effect without a restart.
   */
  constructor(
    public readonly id: string,
    private readonly path: string,
  ) {}

  async fetch(): Promise<ServerDetail[]> {
    return readStaticServers(this.path);
  }
}

const CATALOG_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

/**
 * Load a `ServerDetail[]` from a YAML/JSON file OR a directory of
 * them. For a directory, every `*.yaml`/`*.yml`/`*.json` is read in
 * sorted filename order — splitting curation across files (e.g.
 * `curated.yaml` + `composio.yaml`) is a GitOps convenience that still
 * rolls up to a single registry. Each file is validated independently
 * so drop warnings name the originating file, while a shared
 * name-dedup set across files gives "first file (sorted) wins". A
 * missing path returns empty; an unreadable / unparseable individual
 * file is skipped with a logged warning while the rest still load.
 */
export function readStaticServers(path: string): ServerDetail[] {
  if (!existsSync(path)) {
    log.warn(`[static-source] ${path}: not found — returning empty`);
    return [];
  }
  const files = statSync(path).isDirectory() ? catalogFilesInDir(path) : [path];
  const out: ServerDetail[] = [];
  const seenNames = new Set<string>();
  for (const file of files) {
    const parsed = parseCatalogFile(file);
    if (parsed === undefined) continue; // unreadable / unparseable — already warned
    appendValidatedServers(extractServerCandidates(parsed, file), file, seenNames, out);
  }
  return out;
}

/**
 * List the catalog files in a directory: `*.yaml`/`*.yml`/`*.json`
 * only, sorted by filename so cross-file "first wins" dedup is
 * deterministic. Flat (non-recursive) by design — a connectors
 * ConfigMap mounts as a flat directory of keys.
 */
function catalogFilesInDir(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => CATALOG_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Read + parse one catalog file. Returns the parsed body, or
 * `undefined` when the file is unreadable or unparseable (logged) so
 * the caller can skip it without sinking sibling files.
 */
function parseCatalogFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    log.warn(
      `[static-source] failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  try {
    const ext = extname(file).toLowerCase();
    return ext === ".yaml" || ext === ".yml" ? Bun.YAML.parse(text) : JSON.parse(text);
  } catch (err) {
    log.warn(
      `[static-source] failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Pull the raw server-candidate list out of a parsed file body.
 * Accepts `{ servers: [ ... ] }` (canonical) or a bare `[ ... ]`
 * array. Anything else logs and yields nothing.
 */
function extractServerCandidates(parsed: unknown, source: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { servers?: unknown }).servers)
  ) {
    return (parsed as { servers: unknown[] }).servers;
  }
  log.warn(`[static-source] ${source} did not yield a top-level 'servers' list or bare array`);
  return [];
}

/**
 * Validate raw candidates and append the survivors to `out`, deduping
 * by name against the shared `seenNames` set so a caller aggregating
 * multiple files gets first-wins dedup across them. Keeps only entries
 * that pass the upstream `ServerDetail` ajv schema (the platform's
 * defense-in-depth safety checks run later, uniformly, at the directory
 * boundary). Each drop is logged with a `source[index:name]` tag naming
 * where it came from — for the directory path, `source` is the
 * individual file, not the dir.
 */
function appendValidatedServers(
  raw: unknown[],
  source: string,
  seenNames: Set<string>,
  out: ServerDetail[],
): void {
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
}

function candidateName(c: unknown): string | undefined {
  if (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string") {
    return (c as { name: string }).name;
  }
  return undefined;
}
