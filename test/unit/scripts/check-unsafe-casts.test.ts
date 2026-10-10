/**
 * Self-tests for `scripts/check-unsafe-casts.ts`.
 *
 * `namesMismatch` and `findUnsafeCasts` are exercised on in-memory text; `scan`
 * on a planted tree and on this repo, which must be clean; and the script itself
 * is spawned against both, so the exit code CI gates on is covered.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUnsafeCasts, namesMismatch, scan } from "../../../scripts/check-unsafe-casts.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The 1-based lines of the casts in `text` that fail the check. */
function failing(text: string, file = "s.ts"): number[] {
  return findUnsafeCasts(file, text)
    .filter((c) => !c.ok)
    .map((c) => c.line);
}

describe("namesMismatch", () => {
  test("passes a comment that names what the value is and what the code claims", () => {
    expect(namesMismatch("// partial stub: only `get` is called")).toBe(true);
    expect(
      namesMismatch(
        "/* The SDK types the result as the tool's own; a task result is the other. */",
      ),
    ).toBe(true);
  });

  test("fails an empty or placeholder comment", () => {
    for (const text of [
      "//",
      "// cast",
      "// type hack",
      "// TODO: fix types",
      "// SDK type gap",
      "/* unsafe cast, intentional */",
      "// necessary workaround for typescript",
    ]) {
      expect(namesMismatch(text)).toBe(false);
    }
  });

  test("does not count a lint directive as words", () => {
    expect(namesMismatch("// biome-ignore lint/suspicious/noExplicitAny: cast")).toBe(false);
    expect(namesMismatch("// eslint-disable-next-line no-explicit-any")).toBe(false);
    expect(namesMismatch("// deno-lint-ignore no-explicit-any")).toBe(false);
    expect(namesMismatch("// @ts-expect-error")).toBe(false);
  });
});

describe("findUnsafeCasts", () => {
  test("flags an uncommented double cast, and its `<T><unknown>x` form", () => {
    const text = [
      "const a = value as unknown as Foo;",
      "const b = (value as unknown) as Foo;",
      "const c = <Foo>(<unknown>value);",
      "const d = (value as unknown)! as Foo;",
    ].join("\n");
    expect(failing(text)).toEqual([1, 2, 3, 4]);
  });

  test("ignores a single assertion and an assertion to unknown alone", () => {
    const text = ["const a = value as Foo;", "const b = value as unknown;"].join("\n");
    expect(findUnsafeCasts("s.ts", text)).toEqual([]);
  });

  test("ignores the phrase in a string or a comment", () => {
    const text = ['const a = "x as unknown as Foo";', "// value as unknown as Foo"].join("\n");
    expect(findUnsafeCasts("s.ts", text)).toEqual([]);
  });

  test("passes a qualifying comment on the same line or the line above", () => {
    const text = [
      "const a = value as unknown as Foo; // partial stub: only `get` is called",
      "// partial stub: only `get` is called",
      "const b = value as unknown as Foo;",
    ].join("\n");
    expect(failing(text)).toEqual([]);
  });

  test("reads a run of `//` lines and a block comment above as one comment", () => {
    const text = [
      "// The SDK types the result",
      "// as the tool's own output.",
      "const a = value as unknown as Foo;",
      "/**",
      " * A legacy row as it sits on disk.",
      " */",
      "const b = value as unknown as Foo;",
    ].join("\n");
    expect(failing(text)).toEqual([]);
  });

  test("fails a comment two lines above, or a placeholder beside the cast", () => {
    const text = [
      "// partial stub: only `get` is called",
      "",
      "const a = value as unknown as Foo;",
      "const b = value as unknown as Foo; // cast",
    ].join("\n");
    expect(failing(text)).toEqual([3, 4]);
  });

  test("does not read a trailing comment on the line of code above", () => {
    const text = [
      "const limit = 10; // the default page size for every list",
      "const a = value as unknown as Foo;",
    ].join("\n");
    expect(failing(text)).toEqual([2]);
  });

  test("passes a comment above a multi-line cast's first line", () => {
    const text = [
      "// A Window reduced to the `postMessage` the bridge calls.",
      "const stub = {",
      "  postMessage() {},",
      "} as unknown as Window;",
    ].join("\n");
    expect(failing(text)).toEqual([]);
  });

  test("reads a comment inside a JSX expression container", () => {
    const text = [
      "const el = (",
      "  <div>",
      "    {/* a fixture with only the `id` the row reads */}",
      "    {row as unknown as Row}",
      "  </div>",
      ");",
    ].join("\n");
    expect(failing(text, "s.tsx")).toEqual([]);
  });
});

describe("scan", () => {
  const root = mkdtempSync(join(tmpdir(), "nb-check-unsafe-casts-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const BAD = "export const a = value as unknown as Foo;\n";
  mkdirSync(join(root, "src", "tools"), { recursive: true });
  writeFileSync(join(root, "src", "tools", "a.ts"), BAD);
  mkdirSync(join(root, "src", "platform", "files", "ui", "node_modules", "dep"), {
    recursive: true,
  });
  writeFileSync(join(root, "src", "platform", "files", "ui", "node_modules", "dep", "x.ts"), BAD);
  mkdirSync(join(root, "test", "unit"), { recursive: true });
  writeFileSync(join(root, "test", "unit", "out-of-scope.test.ts"), BAD);

  test("flags a cast under a scope root, and skips vendored code and trees out of scope", () => {
    expect(
      scan(root)
        .filter((c) => !c.ok)
        .map((c) => `${c.file}:${c.line}`),
    ).toEqual(["src/tools/a.ts:1"]);
  });

  test("passes on this repo", () => {
    expect(scan(REPO_ROOT).filter((c) => !c.ok)).toEqual([]);
  });

  async function runCheck(
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "--no-env-file", "scripts/check-unsafe-casts.ts", ...args],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return {
      exitCode,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  }

  test("the script exits 1 on the planted tree and names the cast", async () => {
    const { exitCode, stderr } = await runCheck([root]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/tools/a.ts:1");
    expect(stderr).toContain("names its mismatch");
  });

  test("the script exits 0 on this repo", async () => {
    const { exitCode, stdout } = await runCheck([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("name their mismatch");
  });
});
