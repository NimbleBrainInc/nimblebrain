import { describe, expect, it, spyOn } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

/**
 * `listResources` is the best-effort discovery probe SEP-2640 skill loading rides
 * on: it enumerates `resources/list`, follows pagination up to a page cap, and
 * never routes a failure through session recovery. It returns `{ resources, ok }`
 * — `ok: false` flags an enumeration that couldn't complete cleanly (a transport
 * error mid-list, or a torn-down client), so the caller declines to cache it as a
 * stable "no skills". Only a genuine successful response — a clean empty page or a
 * cap-hit — is `ok: true`.
 */
function makeSource(client: unknown): McpSource {
  const source = new McpSource(
    "stub",
    { type: "remote", url: new URL("http://localhost:0/mcp") },
    new NoopEventSink(),
  );
  (source as unknown as { client: unknown }).client = client;
  return source;
}

describe("McpSource.listResources", () => {
  it("returns ok:false when the client is torn down (transient — retry, don't cache empty)", async () => {
    expect(await makeSource(null).listResources()).toEqual({ resources: [], ok: false });
  });

  it("treats a clean empty enumeration as ok (genuinely no resources)", async () => {
    const source = makeSource({ listResources: async () => ({ resources: [] }) });
    expect(await source.listResources()).toEqual({ resources: [], ok: true });
  });

  it("follows pagination across pages via nextCursor (ok)", async () => {
    let calls = 0;
    const source = makeSource({
      listResources: async (params?: { cursor?: string }) => {
        calls++;
        return params?.cursor
          ? { resources: [{ uri: "skill://b/SKILL.md", name: "b", mimeType: "text/markdown" }] }
          : {
              resources: [{ uri: "skill://a/SKILL.md", name: "a", mimeType: "text/markdown" }],
              nextCursor: "p2",
            };
      },
    });
    const out = await source.listResources();
    expect(out.ok).toBe(true);
    expect(out.resources.map((r) => r.uri)).toEqual(["skill://a/SKILL.md", "skill://b/SKILL.md"]);
    expect(calls).toBe(2);
  });

  it("reports ok:false with [] when the first page throws", async () => {
    const source = makeSource({
      listResources: async () => {
        throw new Error("transport blip");
      },
    });
    expect(await source.listResources()).toEqual({ resources: [], ok: false });
  });

  it("reports ok:false with the partial collected on a mid-pagination failure", async () => {
    let calls = 0;
    const source = makeSource({
      listResources: async () => {
        calls++;
        if (calls === 1) return { resources: [{ uri: "skill://a/SKILL.md" }], nextCursor: "p2" };
        throw new Error("transport blip");
      },
    });
    const out = await source.listResources();
    expect(out.ok).toBe(false);
    expect(out.resources.map((r) => r.uri)).toEqual(["skill://a/SKILL.md"]);
  });

  it("stops at the page cap (ok) and warns instead of paginating forever", async () => {
    // A server that always returns a cursor would loop; the cap bounds it + warns.
    const source = makeSource({
      listResources: async () => ({
        resources: [{ uri: "skill://x/SKILL.md" }],
        nextCursor: "always-more",
      }),
    });
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await source.listResources();
      expect(out.ok).toBe(true); // bounded success, not an error
      expect(out.resources).toHaveLength(10); // one per capped page
      expect(spy.mock.calls.some((c) => String(c[0]).includes("page cap"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
