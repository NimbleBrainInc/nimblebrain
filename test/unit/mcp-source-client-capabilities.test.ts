/**
 * What `McpSource` claims of itself in the `initialize` handshake.
 *
 * A client capability is a promise a server is entitled to plan around: it says
 * "send me this and I will handle it." Every entry here is therefore checked
 * against a call site that exists, not against an intention.
 *
 * `tasks.list` was the one that wasn't. Nothing in the host calls `listTasks`,
 * and SEP-2663 removes `tasks/list` from the spec, so the claim could only ever
 * have invited a server to expect a client that never arrived.
 *
 * Read from the server end of a real in-process handshake, so what is asserted
 * is what a connector actually receives.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "@modelcontextprotocol/server";
import { textContent } from "../../src/engine/content-helpers.ts";
import { HOST_RESOURCES_CAPABILITY_KEY } from "../../src/host-resources/capability.ts";
import { FACETS_EXTENSION_ID } from "../../src/services/facets-extension.ts";
import { SKILLS_EXTENSION_ID } from "../../src/skills/skills-extension.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";

/** The capabilities the connected server saw us declare. */
function declaredCapabilities(source: McpSource) {
  const server = (source as unknown as { inProcessServer: Server | null }).inProcessServer;
  return server?.getClientCapabilities();
}

describe("McpSource client capabilities", () => {
  let source: McpSource | undefined;
  afterEach(async () => {
    if (source) await source.stop();
    source = undefined;
  });

  test("claims no task capability: the 2025-11-25 tasks utility is not spoken (ADR-0046)", async () => {
    source = await makeInProcessSource("caps", [
      {
        name: "noop",
        description: "Does nothing.",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ content: textContent("{}"), isError: false }),
      },
    ]);

    // The 2026-07-28 tasks extension is claimed per request by the task wire,
    // never on the connection.
    const declared = declaredCapabilities(source);
    expect(declared?.tasks).toBeUndefined();
    expect(declared?.extensions?.["io.modelcontextprotocol/tasks"]).toBeUndefined();
  });

  test("declares the Skills extension, which skill discovery consumes", async () => {
    source = await makeInProcessSource("caps-skills", []);
    // Exercised by `listSkills` + verification in the runtime's discovery.
    expect(declaredCapabilities(source)?.extensions?.[SKILLS_EXTENSION_ID]).toEqual({});
  });

  test("declares the facets extension, which the briefing collector consumes", async () => {
    source = await makeInProcessSource("caps-facets", []);
    // Exercised by the briefing collector's listing and reads.
    expect(declaredCapabilities(source)?.extensions?.[FACETS_EXTENSION_ID]).toEqual({});
  });

  // A platform source has no `connectorContext`, so no host-resources handlers
  // are registered for it; claiming the extension would promise a server
  // requests nobody answers.
  test("does NOT claim host-resources from a source that serves no handlers", async () => {
    source = await makeInProcessSource("caps-host-resources", []);
    expect(
      declaredCapabilities(source)?.extensions?.[HOST_RESOURCES_CAPABILITY_KEY],
    ).toBeUndefined();
  });
});
