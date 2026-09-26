#!/usr/bin/env bun
/**
 * Lint: no internal hosts or real WorkOS identifiers in the public repo.
 *
 * This repo is public and indexed, so a real hostname or identifier in any
 * tracked file (a test fixture, a doc example, a script default) discloses
 * deployment topology or a customer. Examples use fictional values instead:
 * `nb.example.com`, `tenant-a.nb.example.com`, `brain.acme.com`.
 *
 * What this flags, in every git-tracked text file:
 *
 *   1. `internal-platform-host` — the hosted platform's domain, including
 *      any environment label between `platform.` and the company domain.
 *   2. `authkit-subdomain` — a `<subdomain>.authkit.app` host whose
 *      subdomain is not in `FICTIONAL_AUTHKIT_SUBDOMAINS`.
 *   3. `workos-client-id` — the WorkOS client-id shape: `client_01` plus
 *      24 Crockford base-32 characters. Tests use a non-conforming id such
 *      as `client_test`, which the shape never matches.
 *
 * Allow-list: `FICTIONAL_AUTHKIT_SUBDOMAINS` is the only one, and it holds
 * exact subdomain labels (no patterns) that are provably placeholders: the
 * documented example (`myapp`) and the test issuer (`testapp`). Nothing else
 * is exempt: no per-line marker, no file exemption. A value that must be
 * real at runtime comes from an argument or the environment, never from
 * source.
 *
 * Scope: every file `git ls-files` lists, skipping binaries (any NUL byte).
 *
 * Exports `findInternalHosts` for the self-test under `test/unit/scripts/`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? __dirname, "..");

/** Exact `<label>.authkit.app` subdomains that are placeholders, not tenants. */
export const FICTIONAL_AUTHKIT_SUBDOMAINS: ReadonlySet<string> = new Set(["myapp", "testapp"]);

const PLATFORM_HOST = /platform\.(?:[a-z0-9-]+\.)?nimblebrain\.ai/gi;
// The lookbehind keeps a template (`${domain}.authkit.app`) from matching
// on a trailing fragment of the expression.
const AUTHKIT_HOST = /(?<![a-z0-9-])([a-z0-9-]+)\.authkit\.app/gi;
const WORKOS_CLIENT_ID = /client_01[0-9A-HJKMNP-TV-Z]{24}/gi;

export interface Finding {
  rule: "internal-platform-host" | "authkit-subdomain" | "workos-client-id";
  line: number;
  column: number;
  match: string;
}

/** Every finding in `text`, in line order. Pure, for the self-test. */
export function findInternalHosts(text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const m of line.matchAll(PLATFORM_HOST)) {
      findings.push({
        rule: "internal-platform-host",
        line: i + 1,
        column: m.index + 1,
        match: m[0],
      });
    }
    for (const m of line.matchAll(AUTHKIT_HOST)) {
      const label = (m[1] ?? "").toLowerCase();
      if (FICTIONAL_AUTHKIT_SUBDOMAINS.has(label)) continue;
      findings.push({ rule: "authkit-subdomain", line: i + 1, column: m.index + 1, match: m[0] });
    }
    for (const m of line.matchAll(WORKOS_CLIENT_ID)) {
      findings.push({ rule: "workos-client-id", line: i + 1, column: m.index + 1, match: m[0] });
    }
  }
  return findings;
}

function trackedFiles(): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (proc.exitCode !== 0) {
    console.error(`✗ git ls-files failed: ${proc.stderr.toString().trim()}`);
    process.exit(2);
  }
  return proc.stdout.toString().split("\0").filter(Boolean);
}

function main(): void {
  const violations: string[] = [];
  let scanned = 0;

  for (const rel of trackedFiles()) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, rel), "utf-8");
    } catch {
      // Tracked but absent from the working tree (a deletion not yet staged).
      continue;
    }
    if (text.includes("\0")) continue;
    scanned++;
    for (const f of findInternalHosts(text)) {
      violations.push(`  ${rel}:${f.line}:${f.column}  [${f.rule}]  ${f.match}`);
    }
  }

  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} internal host(s) or identifier(s):\n`);
    for (const v of violations) console.error(v);
    console.error(
      "\nThis repo is public. Use a fictional value (nb.example.com, tenant-a.nb.example.com),",
    );
    console.error("or take a real one from an argument or the environment. See CODE_STYLE.md.");
    process.exit(1);
  }

  console.log(`✓ No internal hosts or WorkOS identifiers in ${scanned} tracked files`);
}

if (import.meta.main) {
  main();
}
