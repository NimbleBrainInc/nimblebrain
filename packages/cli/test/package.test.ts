import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { workerPaths } from "../src/agent-worker.ts";

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

describe("the worker's copy of the built file", () => {
  test("loads as an ES module under a home inside a CommonJS package", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-cli-bundle-"));
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "../src/bin.ts")],
        target: "node",
        minify: true,
      });
      const [out] = built.outputs;
      if (!built.success || out === undefined) throw new Error("the CLI did not build");
      writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}\n');
      const bin = workerPaths(join(dir, "home")).bin;
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, await out.text());
      const check = spawnSync("node", ["--check", bin], { encoding: "utf8" });
      expect({ status: check.status, stderr: check.stderr }).toEqual({ status: 0, stderr: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
