/**
 * Snapshot history for skill files — the read side of `_versions/`.
 *
 * Every destructive skill mutation copies the live file to
 * `{dir}/_versions/{name}.{stamp}.md` first. The snapshots existed before this
 * module and were written by one call site and read by another, each
 * re-deriving the path convention; nothing could LIST them, so a body-replacing
 * update destroyed content with a backup no tool could reach. That is the same
 * as no backup while costing the disk.
 *
 * The convention lives here now: one place formats the filename, one place
 * parses it back. `stamp` is an ISO 8601 instant with `:` and `.` replaced by
 * `-`, so the filename is filesystem-safe AND lexicographically ordered — a
 * plain string sort is newest-last, which is why listing sorts descending.
 *
 * The loader skips `_versions/` (see `src/skills/loader.ts`), so a snapshot
 * never re-loads as a live skill.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Directory name holding a skill dir's snapshots. Reserved by the loader. */
export const VERSIONS_DIR = "_versions";

/** One snapshot of a skill file. `version` is the id callers pass back. */
export interface SkillVersion {
  /** Timestamp segment of the filename — opaque id for read/restore. */
  version: string;
  /** When the snapshot was taken, ISO 8601. Derived from `version`. */
  savedAt: string;
  /** Size of the snapshot file in bytes. */
  bytes: number;
}

/** `2026-08-13T05:30:00.000Z` → `2026-08-13T05-30-00-000Z`. */
function toStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/**
 * `2026-08-13T05-30-00-000Z` → `2026-08-13T05:30:00.000Z`, or null when the
 * segment isn't a stamp this module wrote. Only the TIME half is rewritten —
 * the date half legitimately contains `-` separators.
 */
function fromStamp(stamp: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * True when a path points INTO a snapshot directory rather than at a live
 * skill. Mutating one of those would snapshot a snapshot — `_versions/` nested
 * in `_versions/` — and the loader skips the whole subtree anyway, so the
 * result would be unreachable by every reader. Callers refuse instead.
 */
export function isSnapshotPath(p: string): boolean {
  return p.split("/").includes(VERSIONS_DIR);
}

/** The `_versions/` directory beside a live skill file. */
export function versionsDirFor(livePath: string): string {
  return join(dirname(livePath), VERSIONS_DIR);
}

/** Base skill name for a live path (`…/foo.md` → `foo`). */
function baseNameFor(livePath: string): string {
  return basename(livePath).replace(/\.md$/, "");
}

/** Absolute path of one snapshot. Does not check existence. */
export function versionFilePath(livePath: string, version: string): string {
  return join(versionsDirFor(livePath), `${baseNameFor(livePath)}.${version}.md`);
}

/**
 * Copy the live file (if any) into `_versions/` before a destructive write.
 * Returns the new version id, or null when there was nothing to snapshot.
 *
 * A same-millisecond second snapshot would collide on filename; the copy
 * overwrites, which is correct — two snapshots of the same instant hold the
 * same bytes.
 */
export function snapshotSkillVersion(livePath: string): string | null {
  if (!existsSync(livePath)) return null;
  const dir = versionsDirFor(livePath);
  mkdirSync(dir, { recursive: true });
  const version = toStamp(new Date().toISOString());
  copyFileSync(livePath, join(dir, `${baseNameFor(livePath)}.${version}.md`));
  return version;
}

/**
 * Snapshots for one skill, newest first. Empty when the skill has never been
 * snapshotted (no `_versions/`, or none belong to this skill).
 *
 * Filters by the skill's own base name: one `_versions/` serves every skill in
 * the directory, so `foo.md`'s history must not include `foo-bar.md`'s. The
 * `.` delimiter after the base name is what keeps those apart.
 */
export function listSkillVersions(livePath: string): SkillVersion[] {
  const dir = versionsDirFor(livePath);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const prefix = `${baseNameFor(livePath)}.`;
  const out: SkillVersion[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".md")) continue;
    const version = entry.slice(prefix.length, -".md".length);
    const savedAt = fromStamp(version);
    // A file that doesn't parse as a stamp wasn't written by us — skip it
    // rather than surfacing a row whose `savedAt` would be a guess.
    if (!savedAt) continue;
    let bytes = 0;
    try {
      bytes = statSync(join(dir, entry)).size;
    } catch {
      continue;
    }
    out.push({ version, savedAt, bytes });
  }
  return out.sort((a, b) => b.version.localeCompare(a.version));
}

/** Raw file content of one snapshot, or null when it doesn't exist. */
export function readSkillVersionRaw(livePath: string, version: string): string | null {
  const path = versionFilePath(livePath, version);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
