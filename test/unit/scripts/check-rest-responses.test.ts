/**
 * Self-tests for `scripts/check-rest-responses.ts`.
 *
 * `findUntypedJson` is exercised on in-memory text; `scan` on a planted tree and
 * on this repo's own `src/`, which must be clean.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUntypedJson, scan } from "../../../scripts/check-rest-responses.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const IMPORTS = `import type { HealthResponse } from "../schemas/responses.ts";
import { json } from "../types.ts";
`;

function lines(text: string): number[] {
  return findUntypedJson("src/api/routes/r.ts", text).map((v) => v.line);
}

describe("findUntypedJson", () => {
  test("passes json<T> with T imported from schemas/responses.ts", () => {
    expect(
      lines(`${IMPORTS}export const h = () => json<HealthResponse>({ status: "ok" });\n`),
    ).toEqual([]);
  });

  test("flags c.json(body) and Response.json(body)", () => {
    const text = `${IMPORTS}const a = (c) => c.json({ ok: true });\nconst b = () => Response.json({ ok: true });\n`;
    expect(lines(text)).toEqual([3, 4]);
  });

  test("ignores reading a body with res.json()", () => {
    expect(lines(`const body = await res.json();\n`)).toEqual([]);
  });

  test("flags new Response(JSON.stringify(...)) outside the helper", () => {
    expect(lines(`const r = new Response(JSON.stringify({ ok: true }));\n`)).toEqual([1]);
    expect(
      findUntypedJson("src/api/types.ts", `const r = new Response(JSON.stringify(body));\n`),
    ).toEqual([]);
  });

  test("flags json<T> with an inline type or a name from elsewhere", () => {
    const text = `${IMPORTS}import type { Other } from "../other.ts";
const a = () => json<{ ok: boolean }>({ ok: true });
const b = () => json<Other>({});
`;
    expect(lines(text)).toEqual([4, 5]);
  });
});

describe("scan", () => {
  const root = mkdtempSync(join(tmpdir(), "nb-check-rest-responses-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("fails on a route writing c.json, and skips the platform app UIs", () => {
    mkdirSync(join(root, "src", "api", "routes"), { recursive: true });
    mkdirSync(join(root, "src", "platform", "files", "ui", "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "api", "routes", "planted.ts"),
      `export const h = (c) => c.json({ ok: true });\n`,
    );
    writeFileSync(
      join(root, "src", "platform", "files", "ui", "src", "app.ts"),
      `export const r = new Response(JSON.stringify({}));\n`,
    );
    expect(scan(root).map((v) => v.file)).toEqual([join("src", "api", "routes", "planted.ts")]);
  });

  test("this repo's src/ is clean", () => {
    expect(scan(REPO_ROOT)).toEqual([]);
  });
});
