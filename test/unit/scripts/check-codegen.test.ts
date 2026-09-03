/**
 * Self-tests for `scripts/check-codegen.ts`.
 *
 * The guard exports its verdict logic so the fail-closed property can be
 * exercised directly, without mutating the working tree mid-run — the
 * reason the check moved out of package.json in the first place. Same
 * pattern as `check-tool-namespace.test.ts`: import the predicates, feed
 * them fixtures, leave `main()` alone.
 */

import { describe, expect, test } from "bun:test";
import { describeCode, parseStatus, verdictFor } from "../../../scripts/check-codegen.ts";

/** A successful git call reporting `stdout`. */
function ran(stdout: string) {
  return { status: 0, stdout, stderr: "" };
}

describe("check-codegen — parseStatus", () => {
  test("clean output yields no entries", () => {
    expect(parseStatus("")).toEqual([]);
  });

  test("a trailing newline does not become an entry", () => {
    expect(parseStatus("?? web/src/_generated/probe.d.ts\n")).toHaveLength(1);
  });

  test("splits the two-character code from the path", () => {
    expect(parseStatus("?? web/src/_generated/platform-schemas/probe.d.ts")).toEqual([
      { code: "??", path: "web/src/_generated/platform-schemas/probe.d.ts" },
    ]);
  });

  test("reads the codes for modified, deleted, and staged paths", () => {
    const out = [
      " M web/src/_generated/workspace-id-pattern.ts",
      " D web/src/_generated/platform-schemas/home.d.ts",
      "M  web/src/_generated/personal-connector-prefix.ts",
    ].join("\n");
    expect(parseStatus(out).map((e) => e.code)).toEqual([" M", " D", "M "]);
  });

  test("keeps a rename's whole tail as the path", () => {
    expect(parseStatus("R  web/src/_generated/a.d.ts -> web/src/_generated/b.d.ts")[0]?.path).toBe(
      "web/src/_generated/a.d.ts -> web/src/_generated/b.d.ts",
    );
  });
});

describe("check-codegen — describeCode", () => {
  test("names the untracked case distinctly", () => {
    // The case `git diff` over tracked paths cannot report at all, and
    // the one whose fix is `git add`, not a regeneration.
    expect(describeCode("??")).toBe("generated but never added to git");
  });

  test("distinguishes deleted from modified", () => {
    expect(describeCode(" D")).not.toBe(describeCode(" M"));
  });

  test("falls back rather than throwing on an unfamiliar code", () => {
    expect(describeCode("XY")).toBe("reported as changed");
  });
});

describe("check-codegen — verdictFor fails closed", () => {
  test("passes only when git succeeded and reported nothing", () => {
    expect(verdictFor(ran(""))).toEqual({ ok: true });
  });

  test("fails when git could not be spawned", () => {
    const verdict = verdictFor({
      error: new Error("spawn git ENOENT"),
      status: null,
      stdout: "",
      stderr: "",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: "git-failed" });
  });

  test("fails on a non-zero git exit even with empty output", () => {
    // The shape a `git status | grep .` pipeline reports as clean: git
    // wrote nothing to stdout, so grep finds no match and the negation
    // passes. Empty output from a failed git is not evidence of a clean
    // tree.
    const verdict = verdictFor({
      status: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: "git-failed" });
    if (!verdict.ok && verdict.reason === "git-failed") {
      expect(verdict.detail).toContain("exit 128");
      expect(verdict.detail).toContain("not a git repository");
    }
  });

  test("fails when git was killed by a signal", () => {
    const verdict = verdictFor({ status: null, signal: "SIGKILL", stdout: "", stderr: "" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok && verdict.reason === "git-failed") {
      expect(verdict.detail).toContain("SIGKILL");
    }
  });

  test("reports drift when git succeeded but named a path", () => {
    const verdict = verdictFor(ran("?? web/src/_generated/platform-schemas/probe.d.ts"));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok && verdict.reason === "drift") {
      expect(verdict.entries).toHaveLength(1);
      expect(verdict.entries[0]?.code).toBe("??");
    }
  });
});
