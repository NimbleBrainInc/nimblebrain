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
 *   1. `company-subdomain` — a subdomain of the company domain that is
 *      not in `PUBLIC_COMPANY_SUBDOMAINS`. Anything else on that domain is
 *      internal: hosted tenants, companion services, environments.
 *   2. `authkit-subdomain` — a `<subdomain>.authkit.app` host whose
 *      subdomain is not in `FICTIONAL_AUTHKIT_SUBDOMAINS`.
 *   3. `workos-client-id` — the WorkOS client-id shape: `client_01` plus
 *      24 Crockford base-32 characters. Tests use a non-conforming id such
 *      as `client_test`, which the shape never matches.
 *
 * Allow-lists: `PUBLIC_COMPANY_SUBDOMAINS` holds the public sites, and
 * `FICTIONAL_AUTHKIT_SUBDOMAINS` holds the AuthKit labels that are provably
 * placeholders: the documented example (`myapp`) and the test issuer
 * (`testapp`). Both hold exact labels, not patterns. Nothing else is exempt:
 * no per-line marker, no file exemption. A value that must be
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

/** Exact subdomains of the company domain that are public sites. */
export const PUBLIC_COMPANY_SUBDOMAINS: ReadonlySet<string> = new Set([
  "docs",
  "schemas",
  "static",
  "synapse",
  "www",
]);

// The lookbehind anchors the capture at the host's first literal label, so a
// template (`${tenant}.<sub>.<domain>`) still captures `<sub>`. A bare-domain
// mail address has no subdomain and does not match.
const COMPANY_HOST = /(?<![a-z0-9-])([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.nimblebrain\.ai\b/gi;
// The lookbehind keeps a template (`${domain}.authkit.app`) from matching
// on a trailing fragment of the expression.
const AUTHKIT_HOST = /(?<![a-z0-9-])([a-z0-9-]+)\.authkit\.app/gi;
const WORKOS_CLIENT_ID = /client_01[0-9A-HJKMNP-TV-Z]{24}/gi;

export interface Finding {
  rule: "company-subdomain" | "authkit-subdomain" | "workos-client-id";
  line: number;
  column: number;
  match: string;
}

/**
 * Each rule's pattern, and the allow-list its first capture group is checked
 * against (lower-cased). A rule with no allow-list flags every match.
 */
const RULES: ReadonlyArray<{
  rule: Finding["rule"];
  pattern: RegExp;
  allowed?: ReadonlySet<string>;
}> = [
  { rule: "company-subdomain", pattern: COMPANY_HOST, allowed: PUBLIC_COMPANY_SUBDOMAINS },
  { rule: "authkit-subdomain", pattern: AUTHKIT_HOST, allowed: FICTIONAL_AUTHKIT_SUBDOMAINS },
  { rule: "workos-client-id", pattern: WORKOS_CLIENT_ID },
];

/** Every finding in `text`, in line order. Pure, for the self-test. */
export function findInternalHosts(text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const { rule, pattern, allowed } of RULES) {
      for (const m of line.matchAll(pattern)) {
        if (allowed?.has((m[1] ?? "").toLowerCase())) continue;
        findings.push({ rule, line: i + 1, column: m.index + 1, match: m[0] });
      }
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
