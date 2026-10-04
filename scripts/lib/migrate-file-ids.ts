/**
 * The file-id migration behind `bun run migrate:file-ids`: every stored file
 * whose id is in the retired `fl_<base36>_<8 hex>` form gets a current
 * `fl_<24 hex>` id, and every place the runtime reads that id is rewritten.
 *
 * What holds a file id on disk, and what this does to each:
 *
 *   workspaces/<ws>/files/<owner>/<id>_<name>          blob: renamed
 *   workspaces/<ws>/files/<owner>/<id>.extracted.json  sidecar: renamed
 *   workspaces/<ws>/files/<owner>/registry.jsonl       catalog: rewritten
 *   every other *.json / *.jsonl the runtime reads     rewritten (conversations,
 *                                                      task records, …)
 *
 * Never touched: the blobs' and sidecars' CONTENTS (user data), `logs/`
 * (history), `archived/` (not served), and `users/<id>/files/` (no reader).
 * Occurrences there are counted and reported, never rewritten.
 *
 * Idempotent by construction. The old → new mapping is persisted under
 * `<workDir>/.migrations/file-ids/mapping.json` BEFORE anything else is
 * written, and a re-run reuses it, so an interrupted run resumes with the same
 * new ids and a completed run finds nothing to do. Each rewritten file is
 * copied to `.migrations/file-ids/backups/<run>/<relpath>` first.
 *
 * The pure pieces (`isLegacyFileId`, `rewriteFileIds`) and the tree walk
 * (`planFileIdMigration`, `applyFileIdMigration`) are separate so tests can
 * drive both against a fixture tree.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { generateFileId } from "../../src/files/store.ts";

/** The retired id form: `fl_<Date.now() base36>_<8 hex>`. */
const LEGACY_FILE_ID_RE = /^fl_[a-z0-9]{1,12}_[a-f0-9]{8}$/;

/** A legacy id at the head of a blob name (`<id>_<name>`) or sidecar (`<id>.extracted.json`). */
const LEGACY_DISK_NAME_RE = /^(fl_[a-z0-9]{1,12}_[a-f0-9]{8})(?:_|\.extracted\.json$)/;

/** Any legacy-shaped id inside text, for counting references outside the rewrite set. */
const LEGACY_IN_TEXT_RE = /(?<![A-Za-z0-9_])fl_[a-z0-9]{1,12}_[a-f0-9]{8}(?![a-z0-9])/g;

const MIGRATION_DIR = join(".migrations", "file-ids");
const MAPPING_FILE = "mapping.json";
const REGISTRY_FILE = "registry.jsonl";
const SIDECAR_SUFFIX = ".extracted.json";

export function isLegacyFileId(id: string): boolean {
  return LEGACY_FILE_ID_RE.test(id);
}

/** One legacy file and where it lives. */
export interface MappingRecord {
  newId: string;
  /**
   * The owner partitions holding the file, relative to the work dir
   * (`workspaces/<ws>/files/<owner>`). Usually one; a file copied into a second
   * owner's partition kept its id, and every copy takes the same new id, so
   * each owner's references keep resolving to that owner's copy.
   */
  partitions: string[];
}

/** `oldId → record`, persisted as the audit trail and the resume point. */
export type FileIdMapping = Record<string, MappingRecord>;

/**
 * Replace every occurrence of a mapped old id in `text` — `files://<old>`,
 * a bare `<old>`, and `<old>_<name>` alike. An id is matched only as a whole
 * token, so a longer id that merely contains it is left alone.
 */
export function rewriteFileIds(
  text: string,
  mapping: ReadonlyMap<string, string>,
): { text: string; count: number } {
  if (mapping.size === 0 || !text.includes("fl_")) return { text, count: 0 };
  let count = 0;
  const out = text.replace(LEGACY_IN_TEXT_RE, (match) => {
    const next = mapping.get(match);
    if (!next) return match;
    count++;
    return next;
  });
  return { text: out, count };
}

/** A file whose text references mapped ids. */
export interface RewriteTarget {
  /** Relative to the work dir. */
  path: string;
  kind: "registry" | "conversation" | "other";
  /** Occurrences of mapped ids. */
  refs: number;
}

/** A disk entry to rename: blob or sidecar. */
export interface RenameTarget {
  oldId: string;
  from: string;
  to: string;
  kind: "blob" | "sidecar";
}

export interface FileIdPlan {
  /** Every mapping record in force for this run (reused + newly minted). */
  mapping: FileIdMapping;
  /** Old ids minted in this run (not yet in the persisted mapping). */
  minted: string[];
  renames: RenameTarget[];
  rewrites: RewriteTarget[];
  /** Legacy-shaped ids in rewritten scope that no partition owns; left as they are. */
  orphanRefs: number;
  /** Files outside the rewrite scope that mention a legacy-shaped id, by area. */
  skipped: Record<"logs" | "archived" | "users" | "fileContents", number>;
  /** Fatal inconsistencies; a plan with any is never applied. */
  errors: string[];
}

function mappingPath(workDir: string): string {
  return join(workDir, MIGRATION_DIR, MAPPING_FILE);
}

export function readMapping(workDir: string): FileIdMapping {
  const path = mappingPath(workDir);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as FileIdMapping;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every owner partition: `workspaces/<ws>/files/<owner>`, relative to the work dir. */
function ownerPartitions(workDir: string): string[] {
  const out: string[] = [];
  for (const ws of listDir(join(workDir, "workspaces"))) {
    const filesDir = join("workspaces", ws, "files");
    for (const owner of listDir(join(workDir, filesDir))) {
      const rel = join(filesDir, owner);
      if (isDir(join(workDir, rel))) out.push(rel);
    }
  }
  return out;
}

/** Legacy ids a partition holds: registry ids plus blob and sidecar names. */
function legacyIdsIn(workDir: string, partition: string): Set<string> {
  const ids = new Set<string>();
  const dir = join(workDir, partition);
  let registry = "";
  try {
    registry = readFileSync(join(dir, REGISTRY_FILE), "utf-8");
  } catch {
    // No registry yet.
  }
  for (const line of registry.split("\n")) {
    if (!line.trim()) continue;
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      if (typeof id === "string" && isLegacyFileId(id)) ids.add(id);
    } catch {
      // Malformed line: the store skips it too.
    }
  }
  for (const name of listDir(dir)) {
    const m = LEGACY_DISK_NAME_RE.exec(name);
    if (m?.[1]) ids.add(m[1]);
  }
  return ids;
}

type Area = "rewrite" | "logs" | "archived" | "users" | "fileContents" | "ignore";

/** Which area a work-dir-relative path belongs to. */
function areaOf(rel: string): Area {
  const parts = rel.split(sep);
  const top = parts[0];
  if (top === ".migrations" || top === "node_modules") return "ignore";
  if (top === "logs") return "logs";
  if (top === "archived") return "archived";
  if (top === "users" && parts[2] === "files") return "users";
  if (top === "workspaces" && parts[2] === "files" && parts.length === 5) {
    // Inside an owner partition only the registry is metadata; blobs and
    // sidecars hold user content.
    return parts[4] === REGISTRY_FILE ? "rewrite" : "fileContents";
  }
  const name = parts[parts.length - 1] ?? "";
  if (name.endsWith(".json") || name.endsWith(".jsonl")) return "rewrite";
  return "ignore";
}

function* walkFiles(workDir: string, rel = ""): Generator<string> {
  for (const name of listDir(join(workDir, rel))) {
    const child = rel ? join(rel, name) : name;
    const abs = join(workDir, child);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === ".migrations" || name === "node_modules") continue;
      yield* walkFiles(workDir, child);
    } else if (st.isFile()) {
      yield child;
    }
  }
}

function kindOf(rel: string): RewriteTarget["kind"] {
  if (rel.endsWith(`${sep}${REGISTRY_FILE}`)) return "registry";
  if (rel.split(sep).includes("conversations")) return "conversation";
  return "other";
}

/** Give every legacy id not already mapped a new id. Mutates `mapping`. */
function assignNewIds(workDir: string, mapping: FileIdMapping): string[] {
  const minted: string[] = [];
  for (const partition of ownerPartitions(workDir)) {
    for (const oldId of legacyIdsIn(workDir, partition)) {
      const existing = mapping[oldId];
      if (!existing) {
        mapping[oldId] = { newId: generateFileId(), partitions: [partition] };
        minted.push(oldId);
      } else if (!existing.partitions.includes(partition)) {
        mapping[oldId] = { ...existing, partitions: [...existing.partitions, partition] };
      }
    }
  }
  return minted;
}

/** The blob and sidecar renames still pending for `mapping`. */
function planRenames(workDir: string, mapping: FileIdMapping): RenameTarget[] {
  const renames: RenameTarget[] = [];
  for (const [oldId, rec] of Object.entries(mapping)) {
    for (const partition of rec.partitions) {
      for (const name of listDir(join(workDir, partition))) {
        const isBlob = name.startsWith(`${oldId}_`);
        if (!isBlob && name !== `${oldId}${SIDECAR_SUFFIX}`) continue;
        renames.push({
          oldId,
          from: join(partition, name),
          to: join(partition, `${rec.newId}${name.slice(oldId.length)}`),
          kind: isBlob ? "blob" : "sidecar",
        });
      }
    }
  }
  return renames;
}

/** Every file that mentions a legacy-shaped id, sorted into rewrite targets and skipped areas. */
function scanReferences(
  workDir: string,
  byOld: ReadonlyMap<string, string>,
): Pick<FileIdPlan, "rewrites" | "skipped" | "orphanRefs"> {
  const rewrites: RewriteTarget[] = [];
  const skipped: FileIdPlan["skipped"] = { logs: 0, archived: 0, users: 0, fileContents: 0 };
  let orphanRefs = 0;
  for (const rel of walkFiles(workDir)) {
    const area = areaOf(rel);
    if (area === "ignore") continue;
    const hits = legacyHitsIn(join(workDir, rel));
    if (hits.length === 0) continue;
    if (area !== "rewrite") {
      skipped[area]++;
      continue;
    }
    const refs = hits.filter((h) => byOld.has(h)).length;
    orphanRefs += hits.length - refs;
    if (refs > 0) rewrites.push({ path: rel, kind: kindOf(rel), refs });
  }
  return { rewrites, skipped, orphanRefs };
}

function legacyHitsIn(abs: string): string[] {
  let text: string;
  try {
    text = readFileSync(abs, "utf-8");
  } catch {
    return [];
  }
  if (!text.includes("fl_")) return [];
  return text.match(LEGACY_IN_TEXT_RE) ?? [];
}

/** Build the plan. Reads only; never writes. */
export function planFileIdMigration(workDir: string): FileIdPlan {
  const mapping: FileIdMapping = { ...readMapping(workDir) };
  const minted = assignNewIds(workDir, mapping);
  const errors: string[] = [];
  const renames = planRenames(workDir, mapping);
  for (const r of renames) {
    if (existsSync(join(workDir, r.to))) errors.push(`rename target already exists: ${r.to}`);
  }
  const byOld = new Map(Object.entries(mapping).map(([o, r]) => [o, r.newId]));
  return { mapping, minted, renames, ...scanReferences(workDir, byOld), errors };
}

/**
 * Write `text` over `abs` atomically, keeping its mode. Conversation logs are
 * appended to by the live runtime, so the file is re-checked just before the
 * rename: if it grew since it was read, the caller re-reads and retries rather
 * than drop the appended line.
 */
function replaceIfUnchanged(abs: string, text: string, readSize: number): boolean {
  const tmp = `${abs}.${process.pid}.file-ids.tmp`;
  writeFileSync(tmp, text, { mode: statSync(abs).mode & 0o777 });
  if (statSync(abs).size !== readSize) {
    unlinkSync(tmp);
    return false;
  }
  renameSync(tmp, abs);
  return true;
}

export interface ApplyResult {
  rewritten: number;
  refs: number;
  renamed: number;
  backupDir: string;
}

/**
 * Apply a plan. The mapping is persisted first, so every later step can be
 * re-run from it; rewrites come before renames, so an interrupted run leaves
 * blobs under ids a re-run still recognises.
 */
export function applyFileIdMigration(
  workDir: string,
  plan: FileIdPlan,
  runId: string,
): ApplyResult {
  if (plan.errors.length > 0) throw new Error(`plan has errors: ${plan.errors.join("; ")}`);
  const migrationDir = join(workDir, MIGRATION_DIR);
  const backupDir = join(migrationDir, "backups", runId);
  mkdirSync(migrationDir, { recursive: true });

  const mapFile = mappingPath(workDir);
  const mapTmp = `${mapFile}.tmp`;
  writeFileSync(mapTmp, `${JSON.stringify(plan.mapping, null, 2)}\n`, { mode: 0o600 });
  renameSync(mapTmp, mapFile);

  const byOld = new Map(Object.entries(plan.mapping).map(([o, r]) => [o, r.newId]));
  let rewritten = 0;
  let refs = 0;
  for (const target of plan.rewrites) {
    const abs = join(workDir, target.path);
    const backup = join(backupDir, target.path);
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(abs, backup);
    for (let attempt = 0; ; attempt++) {
      const original = readFileSync(abs, "utf-8");
      const result = rewriteFileIds(original, byOld);
      if (result.count === 0) break;
      if (replaceIfUnchanged(abs, result.text, Buffer.byteLength(original))) {
        rewritten++;
        refs += result.count;
        break;
      }
      if (attempt >= 5) throw new Error(`${target.path} kept changing during rewrite`);
    }
  }

  let renamed = 0;
  // Sidecars first: a blob is the file's existence, so it moves last.
  const ordered = [...plan.renames].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "sidecar" ? -1 : 1,
  );
  for (const r of ordered) {
    renameSync(join(workDir, r.from), join(workDir, r.to));
    renamed++;
  }

  return { rewritten, refs, renamed, backupDir: relative(workDir, backupDir) };
}
