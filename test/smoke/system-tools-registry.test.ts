/**
 * Smoke test for `nb__search` with `scope: "registry"`.
 *
 * Exercises the full `system-tools.search` → `mpak.client.searchBundles`
 * → live registry HTTP path. Lives here (not in test/unit/) because it
 * reaches the network and the registry must contain a known bundle for
 * the assertion to hold — both make it unsuitable for the deterministic
 * unit gate.
 */

import { describe, expect, it } from "bun:test";

import { extractText, textContent } from "../../src/engine/content-helpers.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createSystemTools } from "../../src/tools/system-tools.ts";

async function makeRegistry(): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  const source = await makeInProcessSource("test", [
    {
      name: "greet",
      description: "Say hello",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      handler: async (input) => ({
        content: textContent(`Hello ${input.name}!`),
        isError: false,
      }),
    },
  ]);
  registry.addSource(source);
  return registry;
}

describe("nb__search scope=registry — live mpak registry", () => {
  it("returns results for a known published bundle", async () => {
    const registry = await makeRegistry();
    const systemTools = await createSystemTools(() => registry);

    const result = await systemTools.execute("search", {
      scope: "registry",
      query: "ipinfo",
    });

    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toContain("ipinfo");
  }, 30_000);
});
