import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { defineInProcessApp, type ResourceTemplate } from "../../src/tools/in-process-app.ts";

async function startSource(templates?: ResourceTemplate[]) {
  const source = defineInProcessApp(
    {
      name: "acme-crm",
      version: "1.0.0",
      tools: [],
      resources: new Map([["crm://contacts/c1", "{}"]]),
      ...(templates ? { templates } : {}),
    },
    new NoopEventSink(),
  );
  await source.start();
  return source;
}

describe("McpSource.resourceTemplates", () => {
  it("returns the server's templates", async () => {
    const source = await startSource([
      { uriTemplate: "crm://contacts/{id}", name: "contact" },
      { uriTemplate: "crm://deals/{id}", name: "deal" },
    ]);
    try {
      expect(await source.resourceTemplates()).toEqual([
        { uriTemplate: "crm://contacts/{id}", name: "contact" },
        { uriTemplate: "crm://deals/{id}", name: "deal" },
      ]);
    } finally {
      await source.stop();
    }
  });

  it("is empty when the server does not answer resources/templates/list", async () => {
    const source = await startSource();
    try {
      expect(await source.resourceTemplates()).toEqual([]);
    } finally {
      await source.stop();
    }
  });

  it("answers from the memo after the first read, including once the source stops", async () => {
    const source = await startSource([{ uriTemplate: "crm://contacts/{id}", name: "contact" }]);
    const first = await source.resourceTemplates();
    await source.stop();
    expect(await source.resourceTemplates()).toBe(first);
  });
});
