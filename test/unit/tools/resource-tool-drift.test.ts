/**
 * Drift detection: UI clients vs source tool lists.
 *
 * Inline-HTML resources (files browser) embed a hand-typed client that
 * postMessages JSON-RPC tools/call up to the iframe bridge. Tool names
 * are string literals with no compile-time link to the source's tools()
 * output. Rename a tool and forget to update the client → the UI breaks
 * at runtime. This test extracts every callTool("...", ...) literal from
 * the inline HTML and asserts the target tool actually exists.
 *
 * Vite-built resources (home, usage) call the SDK's typed `useCallTool`
 * from their App.tsx — the regex below cannot find tool names in the
 * minified bundle. Drift coverage for those bundles comes from the SDK
 * envelope-parity test plus runtime smoke checks.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILES_BROWSER_HTML } from "../../../src/tools/platform-resources/files/browser.ts";
import { createFilesSource } from "../../../src/tools/platform/files.ts";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import type { McpSource } from "../../../src/tools/mcp-source.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";

function makeRuntime(workDir: string): Runtime {
  return {
    getWorkDir: () => workDir,
    getWorkspaceScopedDir: () => workDir,
    getCurrentWorkspaceId: () => "ws_drift",
    getCurrentIdentity: () => null,
    getDefaultModel: () => "claude-sonnet-4-6",
    getWorkspaceStore: () => null,
  } as unknown as Runtime;
}

/** Extract every callTool("name", ...) literal name from a UI template. */
function extractCallToolNames(html: string): string[] {
  const matches = html.matchAll(/callTool\(\s*["']([^"']+)["']/g);
  return Array.from(matches, (m) => m[1]);
}

/**
 * Resolve an advertised tool name for a given source, handling the two
 * calling conventions used by resource clients:
 *  - bare "tool" — routes through the bridge to its host source (inferred
 *    from the resource's directory)
 *  - "source__tool" — routes explicitly to that source
 */
async function assertAdvertised(
  name: string,
  defaultSource: McpSource,
  sourcesByPrefix: Record<string, McpSource>,
): Promise<void> {
  let sourceToCheck: McpSource;
  let expectedLocalName: string;
  if (name.includes("__")) {
    const [prefix, local] = name.split("__", 2);
    sourceToCheck = sourcesByPrefix[prefix];
    expect(sourceToCheck, `Unknown source prefix "${prefix}" in callTool("${name}")`).toBeDefined();
    expectedLocalName = local;
  } else {
    sourceToCheck = defaultSource;
    expectedLocalName = name;
  }

  const tools = await sourceToCheck.tools();
  const advertisedLocals = tools.map((t) => t.name.split("__", 2)[1]);
  expect(
    advertisedLocals,
    `callTool("${name}") references a tool not advertised by source "${sourceToCheck.name}". Advertised: ${advertisedLocals.join(", ")}`,
  ).toContain(expectedLocalName);
}

describe("Resource client / source contract — tool names match", () => {
  test("files/browser.ts calls only tools advertised by files source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-drift-files-"));
    try {
      const filesSource = createFilesSource(makeRuntime(dir), new NoopEventSink());
      await filesSource.start();
      try {
        const names = extractCallToolNames(FILES_BROWSER_HTML);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          await assertAdvertised(name, filesSource, { files: filesSource });
        }
      } finally {
        await filesSource.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
