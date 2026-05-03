#!/usr/bin/env bun
/**
 * Generates `web/src/_generated/platform-schemas/` from the canonical
 * TypeBox schemas at `src/tools/platform/schemas/`.
 *
 * Why this exists: web is a separate package (its own Dockerfile,
 * package.json, build context). The web shell needs the catalog's
 * derived TYPES — `ToolInput<S, T>`, `ToolSource`, `ToolName<S>` — for
 * the typed `callTool<S, T>(args)` API in `web/src/api/client.ts` and
 * the `CreateInput` alias in `web/src/pages/settings/SkillsTab.tsx`.
 * It does NOT need the runtime schemas (TypeBox values).
 *
 * Sharing this via a cross-tree TypeScript path alias would force every
 * Dockerfile, dockerignore, Makefile, docker-compose, and CI invocation
 * to know about the cross-tree relationship. Generating a flat .d.ts
 * tree inside web/ keeps web a self-contained package — its build
 * doesn't reach outside web/, and the generated artifact is a normal
 * source file in version control.
 *
 * The generated tree is checked in. CI runs this script and verifies
 * `git diff --exit-code web/src/_generated/` to catch drift.
 *
 * Run: `bun run codegen` (alias for this script — see package.json).
 */

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..");
const SCHEMA_SRC = join(REPO_ROOT, "src/tools/platform/schemas");
const TMP_OUT = join(REPO_ROOT, ".tmp-codegen");
const WEB_DEST = join(REPO_ROOT, "web/src/_generated/platform-schemas");

console.log("[codegen] platform-schemas → web/src/_generated/platform-schemas/");

// Clean previous outputs so removed schemas don't leave stale .d.ts files.
rmSync(TMP_OUT, { recursive: true, force: true });
rmSync(WEB_DEST, { recursive: true, force: true });

// Emit declarations only via the dedicated tsconfig. The dedicated config
// keeps the generation independent of the project tsconfig (which uses
// `noEmit` and other compile-time-only settings).
execSync(`bunx tsc -p scripts/tsconfig.codegen-web.json`, {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

// The tsc output preserves the source dir structure under `outDir`.
// Move just the schemas tree into web/src/_generated/.
mkdirSync(dirname(WEB_DEST), { recursive: true });
cpSync(TMP_OUT, WEB_DEST, { recursive: true });
rmSync(TMP_OUT, { recursive: true, force: true });

console.log(`[codegen] OK → ${WEB_DEST.replace(REPO_ROOT, ".")}`);
