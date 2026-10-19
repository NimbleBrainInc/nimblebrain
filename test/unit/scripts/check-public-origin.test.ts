/**
 * Self-tests for `scripts/check-public-origin.ts`.
 *
 * Exercises the exported `findOriginEnvReads` on in-memory text. The env var
 * names are assembled from fragments so this file reads as plain data.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findOriginEnvReads, SANCTIONED_FILE } from "../../../scripts/check-public-origin.ts";

const WEB = ["NB", "WEB", "URL"].join("_");
const API = ["NB", "API", "URL"].join("_");
const ELSEWHERE = join("api", "somewhere.ts");

function lines(text: string, relPath = ELSEWHERE): number[] {
  return findOriginEnvReads(relPath, text).map((v) => v.line);
}

describe("check-public-origin — forms it flags outside the sanctioned file", () => {
  test("dotted read", () => {
    expect(lines(`const o = process.env.${WEB};`)).toEqual([1]);
  });

  test("bracket read with a string literal", () => {
    expect(lines(`const o = process.env["${API}"];`)).toEqual([1]);
    expect(lines(`const o = process.env[\`${WEB}\`];`)).toEqual([1]);
  });

  test("bracket read with a same-file constant naming the var", () => {
    expect(lines(`const K = "${WEB}";\nconst o = process.env[K]?.trim();`)).toEqual([2]);
  });

  test("destructuring off process.env", () => {
    expect(lines(`const { ${WEB} } = process.env;`)).toEqual([1]);
    expect(lines(`const { "${API}": api } = process.env;`)).toEqual([1]);
  });

  test("the sanctioned file's own read is visible to the check under any other path", () => {
    const real = readFileSync(join(import.meta.dir, "../../../src", SANCTIONED_FILE), "utf-8");
    expect(findOriginEnvReads(ELSEWHERE, real).length).toBeGreaterThan(0);
  });
});

describe("check-public-origin — what passes", () => {
  test("the sanctioned file", () => {
    const real = readFileSync(join(import.meta.dir, "../../../src", SANCTIONED_FILE), "utf-8");
    expect(findOriginEnvReads(SANCTIONED_FILE, real)).toEqual([]);
    expect(lines(`const o = process.env["${WEB}"];`, SANCTIONED_FILE)).toEqual([]);
  });

  test("other env vars, in every form", () => {
    expect(
      lines(
        `const K = "NB_PLATFORM_HOST";\nprocess.env[K];\nprocess.env["NB_TENANT_ID"];\nprocess.env.NB_PUBLIC_ORIGIN;\nconst { HOME } = process.env;`,
      ),
    ).toEqual([]);
  });

  test("an identifier not bound to a forbidden name", () => {
    expect(lines("function read(name: string) { return process.env[name]; }")).toEqual([]);
  });

  test("the allow marker on the line above", () => {
    expect(lines(`// lint-ok:public-origin\nconst o = process.env.${WEB};`)).toEqual([]);
  });
});
