/**
 * Self-tests for `scripts/check-platform-output-types.ts`.
 *
 * `findObjectReturns` is exercised on in-memory text; `scan` on a planted tree
 * and on this repo's own `src/platform/`, which must be clean; and the script
 * itself is spawned against both, so the exit code CI gates on is covered.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findObjectReturns, scan } from "../../../scripts/check-platform-output-types.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const OBJECT_HANDLER = `import type { FileStore } from "../../files/store.ts";

async function handleInfo(store: FileStore, args: { id: string }): Promise<object> {
  return (await store.findEntry(args.id)) ?? {};
}
`;

const NAMED_HANDLER = `import type { FilesInfoOutput } from "../schemas/files.ts";

async function handleInfo(store: FileStore, args: { id: string }): Promise<FilesInfoOutput> {
  return await store.findEntry(args.id);
}
`;

describe("findObjectReturns", () => {
  test("flags a handler declared Promise<object>", () => {
    expect(findObjectReturns("s.ts", OBJECT_HANDLER)).toEqual([
      {
        file: "s.ts",
        line: 3,
        snippet:
          "async function handleInfo(store: FileStore, args: { id: string }): Promise<object> {",
      },
    ]);
  });

  test("flags `: object` on a function, a method, an arrow, and a function expression", () => {
    const text = [
      "export function handleCreate(args: Record<string, unknown>): object { return {}; }",
      "const server = { handleUpdate(args: Record<string, unknown>): object { return {}; } };",
      "const handleDelete = async (args: Record<string, unknown>): Promise<object> => ({});",
      "const handleTag = function (args: Record<string, unknown>): Promise<object> { return Promise.resolve({}); };",
    ].join("\n");
    expect(findObjectReturns("s.ts", text).map((v) => v.line)).toEqual([1, 2, 3, 4]);
  });

  test("flags `object` inside a union or parentheses", () => {
    const text = [
      "function a(): Promise<object> | object { return {}; }",
      "function b(): (object) { return {}; }",
      "function c(): Promise<object | null> { return Promise.resolve(null); }",
    ].join("\n");
    expect(findObjectReturns("s.ts", text).map((v) => v.line)).toEqual([1, 2, 3]);
  });

  test("passes a handler that returns a named output type", () => {
    expect(findObjectReturns("s.ts", NAMED_HANDLER)).toEqual([]);
  });

  test("ignores a registration signature: a function TYPE whose return is object", () => {
    const text = `function register(
  name: string,
  fn: (input: Record<string, unknown>) => Promise<object> | object,
): void {}
type Handler = (input: Record<string, unknown>) => Promise<object>;
`;
    expect(findObjectReturns("s.ts", text)).toEqual([]);
  });

  test("ignores an object parameter and an object-typed variable", () => {
    const text = `function ok(data: object): ToolResult { return wrap(data); }
const seen = new WeakSet<object>();
const payload: object = {};
`;
    expect(findObjectReturns("s.ts", text)).toEqual([]);
  });

  test("ignores Record<string, unknown> and Promise<unknown>", () => {
    const text = `function a(): Record<string, unknown> { return {}; }
async function b(): Promise<unknown> { return {}; }
`;
    expect(findObjectReturns("s.ts", text)).toEqual([]);
  });
});

describe("scan", () => {
  const root = mkdtempSync(join(tmpdir(), "nb-check-platform-output-types-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "src", "platform", "files", "ui", "src"), { recursive: true });
  writeFileSync(join(root, "src", "platform", "files", "source.ts"), OBJECT_HANDLER);
  writeFileSync(join(root, "src", "platform", "files", "ui", "src", "api.ts"), OBJECT_HANDLER);
  mkdirSync(join(root, "src", "tools"), { recursive: true });
  writeFileSync(join(root, "src", "tools", "helper.ts"), OBJECT_HANDLER);

  test("flags a handler planted under src/platform/, and skips app UIs and other trees", () => {
    expect(scan(root).map((v) => `${v.file}:${v.line}`)).toEqual([
      join("src", "platform", "files", "source.ts:3"),
    ]);
  });

  test("passes on this repo's src/platform/", () => {
    expect(scan(REPO_ROOT)).toEqual([]);
  });

  async function runCheck(
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "--no-env-file", "scripts/check-platform-output-types.ts", ...args],
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

  test("the script exits 1 on the planted tree and names the handler", async () => {
    const { exitCode, stderr } = await runCheck([root]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(join("src", "platform", "files", "source.ts:3"));
    expect(stderr).toContain("named XxxOutput");
  });

  test("the script exits 0 on this repo", async () => {
    const { exitCode, stdout } = await runCheck([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No platform function returns `object`");
  });
});
