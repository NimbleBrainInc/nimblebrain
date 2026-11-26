import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Manifest;
const cli = read(join(import.meta.dir, "../package.json"));
const root = read(join(import.meta.dir, "../../../package.json"));

describe("the published package is one self-contained file", () => {
  test("it has no runtime dependencies, so npx installs nothing beside it", () => {
    expect(cli.dependencies ?? {}).toEqual({});
  });

  test("it runs no install script", () => {
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
      expect(cli.scripts?.[hook]).toBeUndefined();
    }
  });

  test("what the build bundles is pinned as the repo root pins it, which is what the build resolves", () => {
    for (const [name, version] of Object.entries(cli.devDependencies ?? {})) {
      expect({ name, version: root.dependencies?.[name] }).toEqual({ name, version });
    }
  });
});
