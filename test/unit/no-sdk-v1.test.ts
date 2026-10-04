/**
 * The runtime and the web client speak MCP without the v1 SDK
 * (`@modelcontextprotocol/sdk`): both legs of `/mcp`, the connector client and
 * the iframe bridge are on the SDK 2 packages (ADR-0046). This keeps it from
 * coming back unnoticed. The `mcp-sdk-v1-*` aliases are old SDK releases the
 * compatibility test runs as third-party servers; they are not the runtime's.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const WEB = join(ROOT, "web");
const SDK_V1 = "@modelcontextprotocol/sdk";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "node_modules" || entry === "dist" ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

function dependencyNames(dir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
}

describe("no MCP SDK v1", () => {
  test("no runtime or web source file imports it", () => {
    const importing = [join(ROOT, "src"), join(WEB, "src"), join(WEB, "test")]
      .flatMap(sourceFiles)
      .filter((file) => readFileSync(file, "utf-8").includes(`from "${SDK_V1}`));
    expect(importing).toEqual([]);
  });

  test("neither the root nor the web package depends on it", () => {
    expect(dependencyNames(ROOT)).not.toContain(SDK_V1);
    expect(dependencyNames(WEB)).not.toContain(SDK_V1);
  });
});
