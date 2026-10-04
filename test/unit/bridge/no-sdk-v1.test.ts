/**
 * The web client speaks MCP without the v1 SDK (`@modelcontextprotocol/sdk`).
 * The iframe bridge reaches `/mcp` on its 2026-07-28 leg through its own
 * stateless sender (`web/src/mcp-bridge-client.ts`), and the v1 SDK leaves the
 * runtime only once nothing holds it (ADR-0046). This keeps it from coming back
 * into `web/` unnoticed.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "../../../web");
const SDK_V1 = "@modelcontextprotocol/sdk";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe("web/ has no MCP SDK v1", () => {
  test("no source file names it", () => {
    const naming = sourceFiles(join(WEB, "src"))
      .concat(sourceFiles(join(WEB, "test")))
      .filter((file) => readFileSync(file, "utf-8").includes(SDK_V1));
    expect(naming).toEqual([]);
  });

  test("the web package does not depend on it", () => {
    const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain(SDK_V1);
  });
});
