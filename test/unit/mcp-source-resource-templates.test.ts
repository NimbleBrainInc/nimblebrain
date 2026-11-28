import { describe, expect, it, spyOn } from "bun:test";
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

  it("keeps the view a template names for its records, and only a non-empty string", async () => {
    const source = await startSource([
      {
        uriTemplate: "crm://contacts/{id}",
        name: "contact",
        _meta: { "ai.nimblebrain/view": "ui://acme-crm/contacts" },
      },
      { uriTemplate: "crm://deals/{id}", name: "deal", _meta: { "ai.nimblebrain/view": 42 } },
      { uriTemplate: "crm://notes/{id}", name: "note", _meta: { "ai.nimblebrain/view": "" } },
    ]);
    try {
      expect(await source.resourceTemplates()).toEqual([
        { uriTemplate: "crm://contacts/{id}", name: "contact", view: "ui://acme-crm/contacts" },
        { uriTemplate: "crm://deals/{id}", name: "deal" },
        { uriTemplate: "crm://notes/{id}", name: "note" },
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

  it("retries an initial listing failure instead of caching an empty result", async () => {
    const source = await startSource();
    try {
      let attempts = 0;
      spyOn(source.getClient(), "listResourceTemplates").mockImplementation(async () => {
        attempts++;
        if (attempts === 1) throw new Error("temporary outage");
        return { resourceTemplates: [{ uriTemplate: "crm://contacts/{id}", name: "contact" }] };
      });

      expect(await source.resourceTemplates()).toEqual([]);
      expect(await source.resourceTemplates()).toEqual([
        { uriTemplate: "crm://contacts/{id}", name: "contact" },
      ]);
      expect(attempts).toBe(2);
    } finally {
      await source.stop();
    }
  });

  it("collects every page before memoizing the listing", async () => {
    const source = await startSource();
    try {
      const listing = spyOn(source.getClient(), "listResourceTemplates").mockImplementation(
        async (params) => {
          if (params?.cursor === "page-2") {
            return { resourceTemplates: [{ uriTemplate: "crm://deals/{id}", name: "deal" }] };
          }
          expect(params).toBeUndefined();
          return {
            resourceTemplates: [{ uriTemplate: "crm://contacts/{id}", name: "contact" }],
            nextCursor: "page-2",
          };
        },
      );

      const templates = await source.resourceTemplates();
      expect(templates).toEqual([
        { uriTemplate: "crm://contacts/{id}", name: "contact" },
        { uriTemplate: "crm://deals/{id}", name: "deal" },
      ]);
      expect(await source.resourceTemplates()).toBe(templates);
      expect(listing).toHaveBeenCalledTimes(2);
    } finally {
      await source.stop();
    }
  });

  it("asks the server again when told to, and remembers the new answer", async () => {
    const source = await startSource([{ uriTemplate: "crm://contacts/{id}", name: "contact" }]);
    try {
      await source.resourceTemplates();
      // A redeployed server behind a stateless transport keeps its connection.
      spyOn(source.getClient(), "listResourceTemplates").mockResolvedValue({
        resourceTemplates: [{ uriTemplate: "crm://orgs/{id}", name: "org" }],
      });
      expect((await source.resourceTemplates())[0]?.uriTemplate).toBe("crm://contacts/{id}");
      expect((await source.resourceTemplates({ fresh: true }))[0]?.uriTemplate).toBe(
        "crm://orgs/{id}",
      );
      expect((await source.resourceTemplates())[0]?.uriTemplate).toBe("crm://orgs/{id}");
    } finally {
      await source.stop();
    }
  });

  it("keeps what it remembers when asking again fails", async () => {
    const source = await startSource([{ uriTemplate: "crm://contacts/{id}", name: "contact" }]);
    try {
      const first = await source.resourceTemplates();
      spyOn(source.getClient(), "listResourceTemplates").mockRejectedValue(
        new Error("unreachable"),
      );
      expect(await source.resourceTemplates({ fresh: true })).toEqual(first);
      expect(await source.resourceTemplates()).toEqual(first);
    } finally {
      await source.stop();
    }
  });

  it("keeps the prior memo when a later page fails", async () => {
    const source = await startSource([{ uriTemplate: "crm://contacts/{id}", name: "contact" }]);
    try {
      const first = await source.resourceTemplates();
      spyOn(source.getClient(), "listResourceTemplates").mockImplementation(async (params) => {
        if (params?.cursor === "page-2") throw new Error("second page unavailable");
        return {
          resourceTemplates: [{ uriTemplate: "crm://deals/{id}", name: "deal" }],
          nextCursor: "page-2",
        };
      });

      expect(await source.resourceTemplates({ fresh: true })).toBe(first);
      expect(await source.resourceTemplates()).toBe(first);
    } finally {
      await source.stop();
    }
  });

  it("does not cache a listing whose cursor repeats", async () => {
    const source = await startSource();
    try {
      const listing = spyOn(source.getClient(), "listResourceTemplates").mockResolvedValue({
        resourceTemplates: [],
        nextCursor: "same-page",
      });
      expect(await source.resourceTemplates()).toEqual([]);
      expect(listing).toHaveBeenCalledTimes(2);
      expect(await source.resourceTemplates()).toEqual([]);
      expect(listing).toHaveBeenCalledTimes(4);
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

  it("reads the templates again after a reconnect", async () => {
    const source = await startSource([{ uriTemplate: "crm://contacts/{id}", name: "contact" }]);
    const first = await source.resourceTemplates();
    await source.stop();
    await source.start();
    try {
      const second = await source.resourceTemplates();
      expect(second).not.toBe(first);
      expect(second).toEqual(first);
    } finally {
      await source.stop();
    }
  });
});
