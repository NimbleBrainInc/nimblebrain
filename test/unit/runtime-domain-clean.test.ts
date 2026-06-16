import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";

/**
 * Standing guard: the runtime kernel stays generic.
 *
 * Capability lives in MCP servers, not in `src/`. This test is a ratchet that
 * fails the moment a *domain capability* leaks back into the runtime.
 *
 * What it polices — and what it deliberately does NOT.
 *
 *   - It matches DOMAIN identifiers: the snake_case tool / task_type name
 *     `deep_research`, and a `report` used as a capability artifact type
 *     (`research.report`, `report_artifact`, `ResearchReport`, …). Those are
 *     capability vocabulary; in `src/` they signal a tool that belongs in an
 *     MCP server.
 *
 *   - It does NOT match the generic `artifact://` resolver or the word
 *     "artifact". That resolver is the read-side of a FOUNDATIONAL kernel
 *     primitive — the sibling of the `files://` upload resolver — reusable by
 *     every future capability. It resolves *any* `artifact://<id>` and renders
 *     *any* mime; it carries no `deep_research` / `report` logic. Policing it
 *     would punish making the kernel more generic, which is backwards. (The
 *     previous version of this gate counted the bare word "artifact"; that
 *     baseline is obsolete now that the generic resolver lives in the kernel.)
 *
 *   - It does NOT match third-party model catalog names like
 *     `o3-deep-research` (hyphenated) — those are vendor data, not our
 *     capability. Matching `deep_research` (underscore) sidesteps them.
 *
 * The ceiling is 0: the kernel has no domain capability today. A ratchet — if a
 * legitimate, generic hit ever appears, narrow the matcher rather than raising
 * the ceiling. Wanting to raise it is the signal that a capability is being put
 * in the wrong place.
 *
 * Reconciliation with PR #440 (`feat/close-437-grep-gate`): #440 introduced
 * this file with a matcher of `deep.?research|artifact` and a benign-baseline
 * ceiling of 20 (English phrase + model-catalog names + the word "artifact" +
 * service names). That matcher predates the generic `artifact://` host resolver
 * landing in the kernel, which legitimately adds ~130 "artifact" hits and would
 * blow the ceiling. This version REPLACES that matcher with a domain-only one
 * (ceiling 0) so the generic resolver passes while a real domain term
 * (`deep_research`, a `report` capability type) still trips the gate. When #440
 * and this branch reconcile, keep THIS matcher.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");

// Domain-capability matcher. `deep_research` is the snake_case tool / task_type
// identifier (NOT the hyphenated vendor model `o3-deep-research`). The `report`
// alternatives match a capability artifact type, not the English word: it must
// be bound to `research`/`artifact` or appear as a snake/camel identifier.
const DOMAIN_TERM_RE =
  "deep_research|research[._-]report|report[._-]artifact|ResearchReport";

// The kernel carries no domain capability. This is a hard ceiling, not a
// benign-baseline budget.
const DOMAIN_HIT_CEILING = 0;

function grepDomainHits(): string[] {
  // `--untracked` so a not-yet-committed file (the most likely way a capability
  // lands back in the kernel) is also caught.
  const result = spawnSync(
    ["git", "grep", "--untracked", "-niE", DOMAIN_TERM_RE, "--", "src/*"],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  // `git grep` exits 1 when there are no matches; treat that as empty, anything
  // else (e.g. exit 128 — not a work tree) as a real failure.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`git grep failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

describe("runtime stays domain-clean", () => {
  test("no domain capability (deep_research / report artifact) in src/", () => {
    const hits = grepDomainHits();
    if (hits.length > DOMAIN_HIT_CEILING) {
      const offenders = hits.join("\n");
      throw new Error(
        `Found ${hits.length} domain-capability hits in src/, ceiling is ${DOMAIN_HIT_CEILING}. ` +
          `A capability (e.g. deep_research, a research report) has likely leaked into the ` +
          `runtime kernel — it belongs in an MCP server. The generic artifact:// resolver is ` +
          `NOT policed here (it is kernel infrastructure). Hits:\n${offenders}`,
      );
    }
    expect(hits.length).toBeLessThanOrEqual(DOMAIN_HIT_CEILING);
  });

  test("the generic artifact:// resolver is allowed in the kernel", () => {
    // Affirmative guard: the generic resolver SHOULD be present (it is kernel
    // infrastructure), and it must NOT carry domain terms. If this file ever
    // disappears the matcher above silently policing nothing would go unnoticed.
    const resolverPath = join(REPO_ROOT, "src", "host-resources", "artifacts", "artifact-resolver.ts");
    expect(existsSync(resolverPath)).toBe(true);
    const grep = spawnSync(
      ["git", "grep", "--untracked", "-niE", DOMAIN_TERM_RE, "--", "src/host-resources/artifacts/*"],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const hits = grep.stdout
      .toString()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(hits).toEqual([]);
  });

  test("output-store and get-output never reappear in the kernel", () => {
    expect(existsSync(join(REPO_ROOT, "src", "files", "output-store.ts"))).toBe(false);
    expect(existsSync(join(REPO_ROOT, "src", "tools", "get-output.ts"))).toBe(false);
  });
});
