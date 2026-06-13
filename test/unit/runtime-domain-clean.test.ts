import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";

/**
 * Standing guard: the runtime kernel stays generic.
 *
 * Capability lives in MCP servers, not in `src/`. A handful of generic
 * mentions of "deep research" (an English phrase, third-party model
 * catalog names) and "artifact" (the English word, plus service names)
 * legitimately occur in the kernel and form a fixed baseline. Anything
 * above that baseline means a domain capability has leaked back into the
 * runtime — this test fails loudly so it cannot ride in unnoticed.
 *
 * The ceiling is the exact count of those benign mentions today. It is a
 * ratchet: if you legitimately remove a benign hit, lower the ceiling in
 * the same change. If you find yourself wanting to raise it, that is the
 * signal that a capability is being put in the wrong place.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");

// Benign baseline in `src/`: an English phrase, a third-party model
// catalog, the English word "artifact", and platform service names.
// Net-new domain code would push the count above this.
const DOMAIN_HIT_CEILING = 20;

function grepDomainHits(): string[] {
  // `--untracked` so a not-yet-committed file (the most likely way a
  // capability lands back in the kernel) is also caught.
  const result = spawnSync(
    [
      "git",
      "grep",
      "--untracked",
      "-niE",
      "deep.?research|artifact",
      "--",
      "src/*",
    ],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  // `git grep` exits 1 when there are no matches; treat that as empty,
  // anything else (e.g. exit 128 — not a work tree) as a real failure.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(
      `git grep failed (exit ${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

describe("runtime stays domain-clean", () => {
  test("no net-new 'deep research' / 'artifact' hits in src/", () => {
    const hits = grepDomainHits();
    if (hits.length > DOMAIN_HIT_CEILING) {
      const offenders = hits.join("\n");
      throw new Error(
        `Found ${hits.length} 'deep research' / 'artifact' hits in src/, ` +
          `ceiling is ${DOMAIN_HIT_CEILING}. A domain capability has likely ` +
          `leaked into the runtime kernel — it belongs in an MCP server. ` +
          `Hits:\n${offenders}`,
      );
    }
    expect(hits.length).toBeLessThanOrEqual(DOMAIN_HIT_CEILING);
  });

  test("output-store and get-output never reappear in the kernel", () => {
    expect(existsSync(join(REPO_ROOT, "src", "files", "output-store.ts"))).toBe(
      false,
    );
    expect(existsSync(join(REPO_ROOT, "src", "tools", "get-output.ts"))).toBe(
      false,
    );
  });
});
