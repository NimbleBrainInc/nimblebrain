import { describe, expect, test } from "bun:test";
import { MemberPoolSource, POOL_WORKSPACE_PRINCIPAL } from "../../src/tools/member-pool-source.ts";
import type { ToolResult } from "../../src/tools/types.ts";
import type { Tool } from "../../src/tools/types.ts";

/**
 * Minimal McpSource stand-in for testing pool dispatch. Implements only
 * the surface MemberPoolSource calls into.
 */
class FakeMcpSource {
  readonly name: string;
  private executeCalls: Array<{ toolName: string; principalId: string | undefined }> = [];
  private toolList: Tool[];
  stopped = false;

  constructor(name: string, tools: Tool[] = []) {
    this.name = name;
    this.toolList = tools;
  }

  async tools(): Promise<Tool[]> {
    return this.toolList;
  }

  async execute(
    toolName: string,
    _input: Record<string, unknown>,
    _signal?: AbortSignal,
    principalId?: string,
  ): Promise<ToolResult> {
    this.executeCalls.push({ toolName, principalId });
    return {
      content: [{ type: "text", text: `${this.name}:${toolName} ok (caller=${principalId})` }],
      isError: false,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  getCalls(): Array<{ toolName: string; principalId: string | undefined }> {
    return this.executeCalls;
  }
}

function tool(name: string, description = ""): Tool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    source: "test",
  };
}

describe("MemberPoolSource", () => {
  test("with no members connected, tools() returns []", async () => {
    const pool = new MemberPoolSource("granola");
    expect(await pool.tools()).toEqual([]);
  });

  test("execute without principalId returns structured error", async () => {
    const pool = new MemberPoolSource("granola");
    const result = await pool.execute("list_meetings", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    if (result.content[0] && "text" in result.content[0]) {
      expect(result.content[0].text).toContain("requires an authenticated principal");
    }
  });

  test("execute with _workspace principal returns same error (member-scope rejects workspace caller)", async () => {
    const pool = new MemberPoolSource("granola");
    const result = await pool.execute("list_meetings", {}, undefined, POOL_WORKSPACE_PRINCIPAL);
    expect(result.isError).toBe(true);
  });

  test("execute for a non-connected member returns pending_auth structured error", async () => {
    const pool = new MemberPoolSource("granola");
    const result = await pool.execute("list_meetings", {}, undefined, "usr_alice");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "pending_auth", serverName: "granola", principalId: "usr_alice" },
    });
  });

  test("execute routes to the right per-member source", async () => {
    const pool = new MemberPoolSource("granola");
    const aliceSrc = new FakeMcpSource("granola", [tool("granola__list_meetings")]);
    const bobSrc = new FakeMcpSource("granola", [tool("granola__list_meetings")]);
    // biome-ignore lint/suspicious/noExplicitAny: test fake stands in for McpSource
    await pool.setMemberSource("usr_alice", aliceSrc as any);
    // biome-ignore lint/suspicious/noExplicitAny: test fake stands in for McpSource
    await pool.setMemberSource("usr_bob", bobSrc as any);

    const r1 = await pool.execute("list_meetings", { x: 1 }, undefined, "usr_alice");
    const r2 = await pool.execute("list_meetings", { x: 2 }, undefined, "usr_bob");
    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);

    // Alice's source saw Alice's call only; Bob's saw Bob's only.
    expect(aliceSrc.getCalls()).toEqual([
      { toolName: "list_meetings", principalId: "usr_alice" },
    ]);
    expect(bobSrc.getCalls()).toEqual([{ toolName: "list_meetings", principalId: "usr_bob" }]);
  });

  test("tools() caches from first connecting member; subsequent setMemberSource doesn't refresh cache", async () => {
    const pool = new MemberPoolSource("granola");
    const aliceSrc = new FakeMcpSource("granola", [tool("granola__list_meetings")]);
    const bobSrc = new FakeMcpSource("granola", [
      tool("granola__list_meetings"),
      tool("granola__archive"),
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: test fake
    await pool.setMemberSource("usr_alice", aliceSrc as any);
    expect((await pool.tools()).length).toBe(1);

    // biome-ignore lint/suspicious/noExplicitAny: test fake
    await pool.setMemberSource("usr_bob", bobSrc as any);
    // Cache still serves Alice's list — assumption: tool surface largely
    // user-independent. Acceptable trade-off documented in the source comment.
    expect((await pool.tools()).length).toBe(1);
  });

  test("setMemberSource replaces an existing entry and stops the old one", async () => {
    const pool = new MemberPoolSource("granola");
    const aliceV1 = new FakeMcpSource("granola");
    const aliceV2 = new FakeMcpSource("granola");
    // biome-ignore lint/suspicious/noExplicitAny: test fake
    await pool.setMemberSource("usr_alice", aliceV1 as any);
    // biome-ignore lint/suspicious/noExplicitAny: test fake
    await pool.setMemberSource("usr_alice", aliceV2 as any);
    expect(aliceV1.stopped).toBe(true);
    expect(aliceV2.stopped).toBe(false);
    expect(pool.getMemberSource("usr_alice")).toBe(aliceV2 as unknown as never);
  });

  test("removeMember stops the source and clears the entry", async () => {
    const pool = new MemberPoolSource("granola");
    const aliceSrc = new FakeMcpSource("granola");
    // biome-ignore lint/suspicious/noExplicitAny: test fake
    await pool.setMemberSource("usr_alice", aliceSrc as any);
    await pool.removeMember("usr_alice");
    expect(aliceSrc.stopped).toBe(true);
    expect(pool.getMemberSource("usr_alice")).toBeUndefined();
  });

  test("stop() tears down all member sources", async () => {
    const pool = new MemberPoolSource("granola");
    const a = new FakeMcpSource("granola");
    const b = new FakeMcpSource("granola");
    // biome-ignore lint/suspicious/noExplicitAny: test fake
    await pool.setMemberSource("a", a as any);
    // biome-ignore lint/suspicious/noExplicitAny: test fake
    await pool.setMemberSource("b", b as any);
    await pool.stop();
    expect(a.stopped).toBe(true);
    expect(b.stopped).toBe(true);
    expect(pool.getMemberIds()).toEqual([]);
  });

  test("execute after stop returns a stopped-bundle error", async () => {
    const pool = new MemberPoolSource("granola");
    await pool.stop();
    const r = await pool.execute("list_meetings", {}, undefined, "usr_alice");
    expect(r.isError).toBe(true);
    if (r.content[0] && "text" in r.content[0]) {
      expect(r.content[0].text).toContain("stopped");
    }
  });
});
