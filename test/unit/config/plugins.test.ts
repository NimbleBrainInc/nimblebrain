import { describe, expect, test } from "bun:test";
import { getValidator } from "../../../src/config/index.ts";
import { enabledPlugins } from "../../../src/config/plugins.ts";

const validate = getValidator();

function errors(config: unknown): string[] {
  validate(config);
  return (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
}

describe("the plugins block", () => {
  test("accepts a builtin system plugin, a path plugin with a server URL, and false", () => {
    expect(
      errors({
        plugins: {
          conversations: { source: "builtin", system: true },
          reports: { source: "./plugins/reports", servers: { records: { url: "http://r/mcp" } } },
          tasks: false,
        },
      }),
    ).toEqual([]);
  });

  test("refuses an entry with no source, an unknown key, a server with no url, and true", () => {
    expect(errors({ plugins: { a: { system: true } } }).length).toBeGreaterThan(0);
    expect(errors({ plugins: { a: { source: "builtin", trusted: true } } }).length).toBeGreaterThan(
      0,
    );
    expect(
      errors({ plugins: { a: { source: "builtin", servers: { app: {} } } } }).length,
    ).toBeGreaterThan(0);
    expect(errors({ plugins: { a: true } }).length).toBeGreaterThan(0);
  });

  test("a plugin's name follows the Agent Plugins name rules", () => {
    expect(errors({ plugins: { "Bad Name": false } }).length).toBeGreaterThan(0);
    expect(errors({ plugins: { "has--double": false } }).length).toBeGreaterThan(0);
    expect(errors({ plugins: { "acme.tools": false } })).toEqual([]);
  });
});

describe("enabledPlugins", () => {
  test("lists the entries that are not false, in order", () => {
    expect(enabledPlugins(undefined)).toEqual([]);
    expect(
      enabledPlugins({ b: { source: "builtin" }, off: false, a: { source: "./a" } }).map(
        ([name]) => name,
      ),
    ).toEqual(["b", "a"]);
  });
});
