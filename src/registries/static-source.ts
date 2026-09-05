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
import {
  type ProjectionContext,
  projectServerDetailToDirectoryEntry,
  validateServerDetailSafety,
} from "./projection.ts";
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
 * One thing the catalog got wrong: a file that could not be read or
 * parsed, a body with no `servers` list, or a single entry that failed
 * validation and was therefore dropped.
 *
 * `message` is the operator-facing sentence, formatted identically to
 * what `readStaticServers` logs (minus the `[static-source] ` prefix).
 * The structured fields let a reporter group by file without re-parsing
 * that sentence.
 */
export interface CatalogDiagnostic {
  /** Catalog file the problem is in — or the path itself, when the path is the problem. */
  source: string;
  /** Entry index within its file. Absent for file-level problems. */
  index?: number;
  /** The entry's `name`, when the candidate carried a usable one. */
  name?: string;
  /** Operator-facing description, already formatted. */
  message: string;
}

/** A surviving entry, kept with where it came from so a later stage can name it. */
interface CatalogEntry {
  detail: ServerDetail;
  source: string;
  index: number;
}

/** A catalog read: the entries that survived, and everything that did not. */
interface CatalogRead {
  entries: CatalogEntry[];
  diagnostics: CatalogDiagnostic[];
}

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
  const { entries, diagnostics } = readCatalog(path);
  for (const d of diagnostics) log.warn(`[static-source] ${d.message}`);
  return entries.map((e) => e.detail);
}

/**
 * Report the entries at `path` that would not reach Browse, without
 * loading them into a registry and without logging.
 *
 * An entry is removed silently at three points, and all three show the
 * operator the same nothing — the connector is absent, no error anywhere:
 *
 *   1. this source's `ServerDetail` schema + name-dedup checks;
 *   2. `validateServerDetailSafety` at the directory boundary — unsafe
 *      icon/docs/portal URL, reserved OAuth param;
 *   3. the directory's projection returning null — `remotes` is optional in
 *      `ServerDetail`, so an entry without one is schema-valid, safety-clean,
 *      and still not installable by this runtime.
 *
 * Stages 2 and 3 delegate to the functions the directory itself calls,
 * so this reports the runtime's decisions rather than restating its
 * rules. They run over survivors and never drop: `readStaticServers`
 * returns what it always did, and the directory boundary stays the one
 * place an entry is actually removed.
 *
 * This is a hand-composed pipeline, and it has already been short by a
 * stage twice. The drift-proof form diffs a real `ConnectorDirectory`
 * list against its input, which cannot live here — `directory.ts`
 * imports this module, so the edge would be a cycle. Tracked as a
 * follow-up.
 *
 * One stage is deliberately not covered: the scope filter
 * (`applyScopeFilter`) is registry configuration, not a property of the
 * catalog file, so it is not this gate's business.
 *
 * `scripts/check-catalog-schema.ts` is the CLI over this. A path that
 * does not exist is itself a diagnostic: a gate pointed at the wrong
 * directory must fail, not pass empty.
 */
export function validateStaticCatalog(path: string): CatalogDiagnostic[] {
  const { entries, diagnostics } = readCatalog(path);
  for (const { detail, source, index } of entries) {
    const tag = `${source}[${index}:${detail.name}]`;
    const safetyError = validateServerDetailSafety(detail);
    if (safetyError) {
      diagnostics.push({
        source,
        index,
        name: detail.name,
        message: `${tag} dropped at the directory boundary — ${safetyError}`,
      });
      continue;
    }
    // The registry coordinates only label the projected entry; nothing
    // the projection can reject depends on them, so a placeholder here
    // gives the same verdict every real registry would.
    if (projectServerDetailToDirectoryEntry(detail, PROBE_CONTEXT) === null) {
      diagnostics.push({
        source,
        index,
        name: detail.name,
        message: `${tag} dropped at the directory boundary — not installable: needs a \`remotes\` entry (this runtime connects to remote MCP servers; it does not acquire \`packages\`)`,
      });
    }
  }
  return diagnostics;
}

/**
 * Registry coordinates for the projection probe above. `validateStaticCatalog`
 * checks a file, not a configured registry, so there are no real ones to pass.
 */
const PROBE_CONTEXT: ProjectionContext = { registryId: "catalog-check", registryType: "static" };

/**
 * The single read both entry points share. Collects rather than logs,
 * so the caller decides whether a problem is a warning to carry on
 * past (the runtime) or a failure (the gate).
 */
function readCatalog(path: string): CatalogRead {
  if (!existsSync(path)) {
    return {
      entries: [],
      diagnostics: [{ source: path, message: `${path}: not found — returning empty` }],
    };
  }
  const files = statSync(path).isDirectory() ? catalogFilesInDir(path) : [path];
  const entries: CatalogEntry[] = [];
  const diagnostics: CatalogDiagnostic[] = [];
  const seenNames = new Set<string>();
  for (const file of files) {
    const parsed = parseCatalogFile(file, diagnostics);
    if (parsed === undefined) continue; // unreadable / unparseable — already reported
    appendValidatedServers(
      extractServerCandidates(parsed, file, diagnostics),
      file,
      seenNames,
      entries,
      diagnostics,
    );
  }
  return { entries, diagnostics };
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
 * `undefined` when the file is unreadable or unparseable (reported) so
 * the caller can skip it without sinking sibling files.
 */
function parseCatalogFile(file: string, diagnostics: CatalogDiagnostic[]): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    diagnostics.push({
      source: file,
      message: `failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return undefined;
  }
  try {
    const ext = extname(file).toLowerCase();
    return ext === ".yaml" || ext === ".yml" ? Bun.YAML.parse(text) : JSON.parse(text);
  } catch (err) {
    diagnostics.push({
      source: file,
      message: `failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return undefined;
  }
}

/**
 * Pull the raw server-candidate list out of a parsed file body.
 * Accepts `{ servers: [ ... ] }` (canonical) or a bare `[ ... ]`
 * array. Anything else logs and yields nothing.
 */
function extractServerCandidates(
  parsed: unknown,
  source: string,
  diagnostics: CatalogDiagnostic[],
): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { servers?: unknown }).servers)
  ) {
    return (parsed as { servers: unknown[] }).servers;
  }
  diagnostics.push({
    source,
    message: `${source} did not yield a top-level 'servers' list or bare array`,
  });
  return [];
}

/**
 * Validate raw candidates and append the survivors to `out`, deduping
 * by name against the shared `seenNames` set so a caller aggregating
 * multiple files gets first-wins dedup across them. Keeps only entries
 * that pass the upstream `ServerDetail` ajv schema (the platform's
 * defense-in-depth safety checks run later, uniformly, at the directory
 * boundary). Each drop is reported with a `source[index:name]` tag naming
 * where it came from — for the directory path, `source` is the
 * individual file, not the dir.
 */
function appendValidatedServers(
  raw: unknown[],
  source: string,
  seenNames: Set<string>,
  out: CatalogEntry[],
  diagnostics: CatalogDiagnostic[],
): void {
  for (let i = 0; i < raw.length; i++) {
    const candidate = raw[i];
    const name = candidateName(candidate);
    const tag = `${source}[${i}${name ? `:${name}` : ""}]`;
    const result = validateServerDetail(candidate);
    if (!result.valid) {
      diagnostics.push({
        source,
        index: i,
        name,
        message: `${tag} dropped — invalid ServerDetail: ${result.errors.join("; ")}`,
      });
      continue;
    }
    const detail = candidate as ServerDetail;
    if (seenNames.has(detail.name)) {
      diagnostics.push({
        source,
        index: i,
        name,
        message: `${tag} dropped — duplicate name "${detail.name}"`,
      });
      continue;
    }
    // Defense-in-depth (URL scheme allowlist + reserved OAuth params)
    // runs uniformly at the directory boundary in
    // `validateServerDetailSafety` — every source is scrubbed there
    // regardless of provenance, so non-curated entries get the
    // same protection static does.
    seenNames.add(detail.name);
    out.push({ detail, source, index: i });
  }
}

function candidateName(c: unknown): string | undefined {
  if (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string") {
    return (c as { name: string }).name;
  }
  return undefined;
}
