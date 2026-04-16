/**
 * Drift detection: UI clients vs source tool lists.
 *
 * Every platform resource (files browser, settings panel, usage dashboard)
 * embeds an HTML/JS client that postMessages JSON-RPC tools/call up to the
 * iframe bridge. Tool names in these client strings are hand-typed and have
 * no compile-time link to the source's tools() output. Rename a tool and
 * forget to update the client → the UI breaks at runtime.
 *
 * This test extracts every callTool("...", ...) literal from each resource
 * and asserts the target tool actually exists on the source that owns it.
 * Unprefixed names route to the source in whose directory the resource
 * lives (files/browser.ts → "files" source); prefixed "source__tool" names
 * route explicitly.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILES_BROWSER_HTML } from "../../../src/tools/platform-resources/files/browser.ts";
import { SETTINGS_PANEL_HTML } from "../../../src/tools/platform-resources/settings/panel.ts";
import { USAGE_DASHBOARD_HTML } from "../../../src/tools/platform-resources/usage/dashboard.ts";
import { createFilesSource } from "../../../src/tools/platform/files.ts";
import { createSettingsSource } from "../../../src/tools/platform/settings.ts";
import { createUsageSource } from "../../../src/tools/platform/usage.ts";
import type { InlineSource } from "../../../src/tools/inline-source.ts";
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
  defaultSource: InlineSource,
  sourcesByPrefix: Record<string, InlineSource>,
): Promise<void> {
  let sourceToCheck: InlineSource;
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
      const filesSource = createFilesSource(makeRuntime(dir));
      const names = extractCallToolNames(FILES_BROWSER_HTML);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        await assertAdvertised(name, filesSource, { files: filesSource });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("settings/panel.ts calls only tools advertised by settings source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-drift-settings-"));
    try {
      const settingsSource = createSettingsSource(makeRuntime(dir));
      const names = extractCallToolNames(SETTINGS_PANEL_HTML);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        await assertAdvertised(name, settingsSource, { settings: settingsSource });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("usage/dashboard.ts calls only tools advertised by usage source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-drift-usage-"));
    try {
      const usageSource = createUsageSource(makeRuntime(dir));
      const names = extractCallToolNames(USAGE_DASHBOARD_HTML);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        await assertAdvertised(name, usageSource, { usage: usageSource });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
