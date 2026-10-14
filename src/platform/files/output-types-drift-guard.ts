/**
 * Compile-time drift guard for file output types.
 *
 * `FileRecord` in `src/platform/schemas/files.ts` is a STRUCTURAL MIRROR of
 * the canonical `FileEntry` in `src/files/types.ts`. It is duplicated because
 * the schemas tree is self-contained for the web codegen
 * (`scripts/tsconfig.codegen-web.json` pins `rootDir` to `schemas/`, so a
 * schema cannot import from outside it).
 *
 * `bun run check` compiles this file. If either type gains, loses, or changes
 * a field the other does not match, an alias below fails with TS2344: update
 * `FileRecord` alongside `FileEntry`.
 *
 * Zero runtime emission: type aliases erase, and this module compiles empty.
 */

import type { FileEntry, FolderEntry } from "../../files/types.ts";
import type { FileRecord, FolderRecord } from "../schemas/files.ts";

/** Fails to compile (TS2344) when `_A` is not assignable to `B`. */
type AssertAssignable<_A extends B, B> = unknown;

/**
 * Fails to compile (TS2344) unless `_T` is `never`. Assignability alone lets an
 * optional field exist on one side only, so the key sets are compared too.
 */
type AssertNever<_T extends never> = unknown;

// Exported only to satisfy `noUnusedLocals`; the constraint is the check.
// FileRecord ↔ FileEntry — bidirectional structural mirror, no overlays.
export type DriftFileRecordA = AssertAssignable<FileRecord, FileEntry>;
export type DriftFileRecordB = AssertAssignable<FileEntry, FileRecord>;
export type DriftFileRecordKeysA = AssertNever<Exclude<keyof FileRecord, keyof FileEntry>>;
export type DriftFileRecordKeysB = AssertNever<Exclude<keyof FileEntry, keyof FileRecord>>;

// FolderRecord ↔ FolderEntry — the same mirror for folders.
export type DriftFolderRecordA = AssertAssignable<FolderRecord, FolderEntry>;
export type DriftFolderRecordB = AssertAssignable<FolderEntry, FolderRecord>;
export type DriftFolderRecordKeysA = AssertNever<Exclude<keyof FolderRecord, keyof FolderEntry>>;
export type DriftFolderRecordKeysB = AssertNever<Exclude<keyof FolderEntry, keyof FolderRecord>>;
