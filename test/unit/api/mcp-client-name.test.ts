/** The name an outside client gives itself on a call: read for attribution, trimmed, capped. */
import { describe, expect, test } from "bun:test";
import { clientNameOf, MAX_CLIENT_NAME_CHARS } from "../../../src/api/mcp-server.ts";

const KEY = "io.modelcontextprotocol/clientInfo";

describe("clientNameOf", () => {
  test("reads the client's own name from the call's _meta", () => {
    expect(clientNameOf({ [KEY]: { name: "Claude Code", version: "2.1.0" } })).toBe("Claude Code");
  });
  test("nothing when the call names no client, or names it oddly", () => {
    expect(clientNameOf(undefined)).toBeUndefined();
    expect(clientNameOf({})).toBeUndefined();
    expect(clientNameOf({ [KEY]: "Claude Code" })).toBeUndefined();
    expect(clientNameOf({ [KEY]: { name: 7 } })).toBeUndefined();
    expect(clientNameOf({ [KEY]: { name: "   " } })).toBeUndefined();
  });
  test("strips control characters and caps the length", () => {
    expect(clientNameOf({ [KEY]: { name: "Evil\nClient\u0000" } })).toBe("EvilClient");
    expect(clientNameOf({ [KEY]: { name: "x".repeat(500) } })).toHaveLength(MAX_CLIENT_NAME_CHARS);
  });
});
