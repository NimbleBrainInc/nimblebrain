import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginsConfig } from "../../../src/config/plugins.ts";
import { type ContractRegistry, loadContracts } from "../../../src/plugins/contracts.ts";
import {
  checkConfiguredPlugins,
  formatPluginError,
  type ResolvedPlugins,
  type ResolvePluginsResult,
  resolvePlugins,
} from "../../../src/plugins/index.ts";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const CONVERSATIONS = "ai.nimblebrain.conversations";
const CONTRACTS: ContractRegistry = loadContracts();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "resolve-plugins-"));
  dirs.push(d);
  return d;
}

/** Write a plugin directory under `base/<dir>` and return the base. */
function writePlugin(
  base: string,
  dir: string,
  manifest: Record<string, unknown>,
  mcpServers?: Record<string, unknown>,
): void {
  mkdirSync(join(base, dir), { recursive: true });
  writeFileSync(
    join(base, dir, "plugin.json"),
    JSON.stringify({ $schema: PLUGIN_SCHEMA, ...manifest }),
  );
  if (mcpServers) {
    writeFileSync(join(base, dir, "mcp.json"), JSON.stringify({ $schema: MCP_SCHEMA, mcpServers }));
  }
}

/** A conversations implementation: one local server serving the contract's tools. */
function writeConversations(base: string, dir = "conversations", name = "conversations"): void {
  writePlugin(
    base,
    dir,
    {
      name,
      version: "0.1.0",
      extensions: {
        "ai.nimblebrain": {
          implements: [
            {
              contract: CONVERSATIONS,
              version: "1.0",
              server: "store",
            },
          ],
        },
      },
    },
    {
      store: { type: "stdio", command: "./bin/store", args: ["--data", "${PLUGIN_DATA}"] },
    },
  );
}

// `in`, not `ok`: the test tsconfig runs without strictNullChecks, which does
// not narrow a union on a boolean discriminant.
function errorsOf(result: ResolvePluginsResult): string[] {
  if (!("errors" in result)) throw new Error("expected errors");
  return result.errors.map(formatPluginError);
}

function resolvedOf(result: ResolvePluginsResult): ResolvedPlugins {
  if ("errors" in result) throw new Error(result.errors.map(formatPluginError).join("\n"));
  return result.resolved;
}

describe("resolvePlugins", () => {
  test("no block, or only plugins turned off, resolves nothing", () => {
    for (const config of [undefined, {}, { tasks: false }] as (PluginsConfig | undefined)[]) {
      const result = resolvePlugins(config, CONTRACTS, { baseDir: "/", dataDir: "/data" });
      expect(result).toEqual({ ok: true, resolved: { plugins: [], bindings: [], notes: [] } });
    }
  });

  test("a system plugin by path: its servers, its binding, its data directory", () => {
    const base = tmp();
    writeConversations(base, "plugins/conversations");
    const result = resolvePlugins(
      { conversations: { source: "./plugins/conversations", system: true } },
      CONTRACTS,
      { baseDir: base, dataDir: "/work/plugin-data" },
    );
    const resolved = resolvedOf(result);
    const [plugin] = resolved.plugins;
    expect(plugin!.system).toBe(true);
    expect(plugin!.root).toBe(join(base, "plugins/conversations"));
    expect(plugin!.servers.store!.spec).toMatchObject({
      type: "stdio",
      command: join(base, "plugins/conversations/bin/store"),
      args: ["--data", "/work/plugin-data/conversations"],
    });
    expect(resolved.bindings).toEqual([
      {
        contract: CONVERSATIONS,
        version: "1.0",
        plugin: "conversations",
        server: "store",
        privateTools: ["create", "events", "append_events", "delete", "delete_workspace"],
      },
    ]);
  });

  test("system comes from the operator only; a stdio server needs it or a url", () => {
    const base = tmp();
    writeConversations(base);
    const notSystem = resolvePlugins({ conversations: { source: "./conversations" } }, CONTRACTS, {
      baseDir: base,
      dataDir: "/d",
    });
    expect(errorsOf(notSystem)).toEqual([
      'conversations (servers.store): server "store" is a stdio server, which the runtime starts only for a system plugin; set "system": true or give it a url',
    ]);

    const byUrl = resolvePlugins(
      {
        conversations: {
          source: "./conversations",
          servers: { store: { url: "http://store.internal:8080/mcp" } },
        },
      },
      CONTRACTS,
      { baseDir: base, dataDir: "/d" },
    );
    expect(resolvedOf(byUrl).plugins[0]!.servers.store!.url).toBe("http://store.internal:8080/mcp");
  });

  test("an operator server entry names a server key, with an http(s) URL", () => {
    const base = tmp();
    writeConversations(base);
    const result = resolvePlugins(
      {
        conversations: {
          source: "./conversations",
          system: true,
          servers: {
            store: { url: "ftp://nope" },
            nothing: { url: "https://x.example" },
          },
        },
      },
      CONTRACTS,
      { baseDir: base, dataDir: "/d" },
    );
    expect(errorsOf(result)).toEqual([
      "conversations (servers.store.url): must be an absolute http or https URL",
      'conversations (servers.nothing.url): "nothing" is not a server of the plugin',
    ]);
  });

  test("a missing source, an unknown builtin, and a name that is not the key are refused", () => {
    const base = tmp();
    writeConversations(base, "renamed", "something-else");
    const result = resolvePlugins(
      {
        missing: { source: "./missing" },
        "no-such-builtin": { source: "builtin" },
        conversations: { source: "./renamed", system: true },
      },
      CONTRACTS,
      { baseDir: base, dataDir: "/d", builtinDir: join(base, "builtin") },
    );
    expect(errorsOf(result)).toEqual([
      `missing: ${join(base, "missing")} holds no plugin.json`,
      'no-such-builtin: no builtin plugin is named "no-such-builtin"',
      'conversations (plugin.json name): the manifest\'s name "something-else" is not the plugin\'s key "conversations"',
    ]);
  });

  test("a builtin resolves under the builtin directory", () => {
    const base = tmp();
    writeConversations(join(base, "builtin"));
    const result = resolvePlugins(
      { conversations: { source: "builtin", system: true } },
      CONTRACTS,
      {
        baseDir: "/",
        dataDir: "/d",
        builtinDir: join(base, "builtin"),
      },
    );
    expect(result.ok).toBe(true);
  });

  test("manifest problems are reported with the plugin, file and field", () => {
    const base = tmp();
    writePlugin(base, "bad", { name: "bad", extensions: { "ai.nimblebrain": { servers: [] } } });
    const result = resolvePlugins({ bad: { source: "./bad" } }, CONTRACTS, {
      baseDir: base,
      dataDir: "/d",
    });
    expect(errorsOf(result)).toEqual([
      'bad (plugin.json extensions["ai.nimblebrain"].servers): must be object',
    ]);
  });

  test("two plugins implementing the singleton conversations contract refuse together", () => {
    const base = tmp();
    writeConversations(base, "one", "one");
    writeConversations(base, "two", "two");
    const result = resolvePlugins(
      { one: { source: "./one", system: true }, two: { source: "./two", system: true } },
      CONTRACTS,
      { baseDir: base, dataDir: "/d" },
    );
    const errors = errorsOf(result);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^one \(ai\.nimblebrain\.conversations\): .*singleton/);
  });

  test("an implementation below the version this runtime consumes is refused", () => {
    const base = tmp();
    writePlugin(
      base,
      "old",
      {
        name: "old",
        extensions: {
          "ai.nimblebrain": {
            implements: [{ contract: CONVERSATIONS, version: "0.9", server: "app" }],
          },
        },
      },
      { app: { type: "streamable-http", url: "https://c.example/mcp" } },
    );
    const result = resolvePlugins({ old: { source: "./old" } }, CONTRACTS, {
      baseDir: base,
      dataDir: "/d",
    });
    expect(errorsOf(result)).toEqual([
      "old (ai.nimblebrain.conversations): version 0.9 does not meet 1.0, the version this runtime consumes (same major, minor at least)",
    ]);
  });
});

describe("checkConfiguredPlugins", () => {
  test("with no plugin enabled it reads nothing, not even the contracts", () => {
    const contracts = new Proxy(new Map(), {
      get() {
        throw new Error("contracts read");
      },
    }) as ContractRegistry;
    expect(checkConfiguredPlugins(undefined, { workDir: "/w", contracts })).toBeNull();
    expect(checkConfiguredPlugins({ tasks: false }, { workDir: "/w", contracts })).toBeNull();
  });

  test("resolves relative to the config file, and throws naming every error", () => {
    const base = tmp();
    writeConversations(base);
    const resolved = checkConfiguredPlugins(
      { conversations: { source: "./conversations", system: true } },
      { workDir: "/w", configPath: join(base, "nimblebrain.json") },
    );
    if (!resolved) throw new Error("expected a resolved set");
    expect(resolved.plugins.map((p) => p.name)).toEqual(["conversations"]);
    expect(resolved.plugins[0]!.servers.store!.spec).toMatchObject({
      args: ["--data", "/w/plugin-data/conversations"],
    });

    expect(() =>
      checkConfiguredPlugins(
        { conversations: { source: "./conversations" }, gone: { source: "./gone" } },
        { workDir: "/w", configPath: join(base, "nimblebrain.json") },
      ),
    ).toThrow(/cannot run:\n {2}- conversations \(servers\.store\).*\n {2}- gone: /);
  });
});
