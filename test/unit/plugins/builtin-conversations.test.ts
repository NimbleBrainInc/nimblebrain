import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { loadContracts } from "../../../src/plugins/contracts.ts";
import {
  BUILTIN_PLUGINS_DIR,
  formatPluginError,
  type ResolvedPlugins,
  resolvePlugins,
} from "../../../src/plugins/index.ts";

const PACKAGE = resolve(import.meta.dir, "../../../packages/conversations");

function resolveBuiltin(): ResolvedPlugins {
  const result = resolvePlugins(
    { conversations: { source: "builtin", system: true } },
    loadContracts(),
    { baseDir: "/", dataDir: "/work/plugin-data" },
  );
  if ("errors" in result) throw new Error(result.errors.map(formatPluginError).join("\n"));
  return result.resolved;
}

describe("the built-in conversations plugin", () => {
  test("lives where builtin plugins are found", () => {
    expect(join(BUILTIN_PLUGINS_DIR, "conversations")).toBe(PACKAGE);
  });

  test("resolves as a system plugin and binds the conversations contract", () => {
    const resolved = resolveBuiltin();
    expect(resolved.notes).toEqual([]);
    const [plugin] = resolved.plugins;
    expect(plugin).toMatchObject({ name: "conversations", root: PACKAGE, system: true });
    expect(resolved.bindings).toEqual([
      {
        contract: "ai.nimblebrain.conversations",
        version: "1.0",
        plugin: "conversations",
        server: "conversations",
        hostVersion: "1.0",
        privateTools: ["create", "events", "append_events", "delete", "delete_workspace"],
        unattendedRefused: ["create", "events", "append_events", "delete", "delete_workspace"],
        grantTools: [],
      },
    ]);
  });

  test("starts its one server from the plugin's root, with its data in its data directory", () => {
    const [plugin] = resolveBuiltin().plugins;
    expect(Object.keys(plugin!.servers)).toEqual(["conversations"]);
    expect(plugin!.servers.conversations!.spec).toMatchObject({
      type: "stdio",
      command: join(PACKAGE, "bin/nb-conversations"),
      args: ["--data-dir", "/work/plugin-data/conversations"],
      cwd: PACKAGE,
    });
  });
});
