/**
 * What survives `tools/list`.
 *
 * An MCP tool listing carries four things beyond the name and description, and
 * the host used to keep two of them. `annotations` and `outputSchema` were read
 * off the wire and dropped on the floor, silently: the server said something
 * about the tool and nothing downstream ever heard it. The failure that costs
 * something is `destructiveHint` — a tool that declares itself destructive was
 * indistinguishable, everywhere in the host, from a read-only one.
 *
 * `_meta` and `annotations` are separate namespaces in the spec, and they stay
 * separate here: `_meta` is the free-form reverse-DNS bag where host
 * conventions like `ai.nimblebrain/internal` live, `annotations` is the spec's
 * own closed set of behavioural hints. Collapsing them is how a bundle would
 * get to claim `readOnlyHint` by writing a `_meta` key, or hide itself from the
 * agent by setting a spec hint.
 *
 * These run end-to-end through a real in-process MCP server over
 * `InMemoryTransport`, so what is asserted is what crosses the wire.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { textContent } from "../../../src/engine/content-helpers.ts";
import { INTERNAL_TOOL_ANNOTATION, isInternalTool } from "../../../src/engine/types.ts";
import type { InProcessTool } from "../../../src/tools/in-process-app.ts";
import type { McpSource } from "../../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import { makeInProcessSource } from "../../helpers/in-process-source.ts";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { deleted: { type: "number" } },
  required: ["deleted"],
};

/** A destructive tool that also carries an outputSchema and a host `_meta` key. */
const purge: InProcessTool = {
  name: "purge",
  description: "Delete every record in the workspace.",
  inputSchema: { type: "object", properties: {} },
  outputSchema: OUTPUT_SCHEMA,
  annotations: { title: "Purge", destructiveHint: true, readOnlyHint: false },
  meta: { ui: { resourceUri: "ui://danger/confirm" } },
  handler: async () => ({ content: textContent("{}"), isError: false }),
};

/** A read-only tool that declares only spec hints. */
const peek: InProcessTool = {
  name: "peek",
  description: "Read one record.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  handler: async () => ({ content: textContent("{}"), isError: false }),
};

describe("tools/list metadata round-trip", () => {
  let source: McpSource | undefined;
  afterEach(async () => {
    if (source) await source.stop();
    source = undefined;
  });

  test("annotations, outputSchema and _meta each land in their own field", async () => {
    source = await makeInProcessSource("danger", [purge]);

    const [tool] = await source.tools();

    expect(tool!.name).toBe("danger__purge");
    expect(tool!.annotations).toEqual({
      title: "Purge",
      destructiveHint: true,
      readOnlyHint: false,
    });
    expect(tool!.outputSchema).toEqual(OUTPUT_SCHEMA);
    expect(tool!.meta).toEqual({ ui: { resourceUri: "ui://danger/confirm" } });
  });

  test("a tool that declares no annotations carries none", async () => {
    source = await makeInProcessSource("plain", [
      {
        name: "noop",
        description: "Does nothing.",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ content: textContent("{}"), isError: false }),
      },
    ]);

    const [tool] = await source.tools();

    expect(tool!.annotations).toBeUndefined();
    expect(tool!.outputSchema).toBeUndefined();
    expect(tool!.meta).toBeUndefined();
  });

  test("the promotion path's tool list carries destructiveHint", async () => {
    // `ToolRegistry.availableTools()` is what the runtime maps into the
    // `ToolSchema[]` the engine hands `surfaceTools` and resolves promotions
    // from. A hint dropped here is a hint no consent or promotion decision can
    // ever consult, however the policy is later written.
    source = await makeInProcessSource("danger", [purge, peek]);
    const registry = new ToolRegistry();
    registry.addSource(source);

    const schemas = await registry.availableTools();

    const destructive = schemas.find((t) => t.name === "danger__purge");
    expect(destructive!.annotations?.destructiveHint).toBe(true);
    expect(destructive!.outputSchema).toEqual(OUTPUT_SCHEMA);

    const readOnly = schemas.find((t) => t.name === "danger__peek");
    expect(readOnly!.annotations?.readOnlyHint).toBe(true);
    expect(readOnly!.annotations?.destructiveHint).toBeUndefined();
  });

  test("the internal marker is read from _meta, never from spec annotations", async () => {
    source = await makeInProcessSource("mixed", [
      // Declares the host marker in `_meta` AND a spec hint. Both must be read
      // from their own namespace: the tool is internal, and it is read-only.
      {
        name: "settings",
        description: "UI-driven settings write.",
        inputSchema: { type: "object", properties: {} },
        meta: { [INTERNAL_TOOL_ANNOTATION]: true },
        annotations: { readOnlyHint: true },
        handler: async () => ({ content: textContent("{}"), isError: false }),
      },
      // Cannot buy its way out of the agent's tool list with a spec hint.
      peek,
    ]);

    const tools = await source.tools();
    const settings = tools.find((t) => t.name === "mixed__settings");
    const visible = tools.find((t) => t.name === "mixed__peek");

    expect(isInternalTool(settings!)).toBe(true);
    expect(settings!.annotations?.readOnlyHint).toBe(true);
    expect(isInternalTool(visible!)).toBe(false);
  });
});
