import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "../../../src/engine/types.ts";
import type { CredentialStore } from "../../../src/tools/credential-store.ts";
import {
  hasMcpOAuthTokens,
  McpOAuthRecords,
  mcpOAuthKey,
} from "../../../src/tools/mcp-oauth-records.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../../helpers/credential-store.ts";
import { seedWorkspaceRoot } from "../../helpers/test-workspace.ts";

const WS = { type: "workspace", wsId: "ws_0076759dbbe19fcc" } as const;
const USER = { type: "user", userId: "usr_alice" } as const;

let workDir: string;
let store: CredentialStore;
let events: EngineEvent[];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-oauth-records-"));
  seedWorkspaceRoot(workDir, "ws_0076759dbbe19fcc");
  events = [];
  store = installTestCredentialStore(workDir, events);
});

afterEach(() => {
  resetTestCredentialStore();
  rmSync(workDir, { recursive: true, force: true });
});

function records(owner: typeof WS | typeof USER, serverName: string): McpOAuthRecords {
  return new McpOAuthRecords({ owner, serverName });
}

describe("mcpOAuthKey", () => {
  test("namespaces by server and record, in the store's key grammar", () => {
    expect(mcpOAuthKey("example-provider", "tokens")).toBe("mcp-oauth.example-provider.tokens");
    expect(mcpOAuthKey("com-acme-mcp", "client")).toBe("mcp-oauth.com-acme-mcp.client");
  });
});

describe("McpOAuthRecords — roundtrip and scope", () => {
  test("a written record reads back through the store at the owner's scope", async () => {
    await records(WS, "example-provider").write("tokens", { access_token: "a" });

    const stored = await store.get(
      { kind: "workspace", wsId: "ws_0076759dbbe19fcc" },
      mcpOAuthKey("example-provider", "tokens"),
      { caller: "test", purpose: "assert" },
    );
    expect(JSON.parse(stored?.reveal() ?? "null")).toEqual({ access_token: "a" });
    expect(
      await records(WS, "example-provider").read<{ access_token: string }>("tokens", {
        caller: "test",
        purpose: "assert",
      }),
    ).toEqual({ access_token: "a" });
  });

  test("workspace and user scope hold independent records under the same key", async () => {
    await records(WS, "example-provider").write("tokens", { access_token: "ws" });
    await records(USER, "example-provider").write("tokens", { access_token: "user" });

    const read = { caller: "test", purpose: "assert" } as const;
    expect(
      await records(WS, "example-provider").read<{ access_token: string }>("tokens", read),
    ).toEqual({
      access_token: "ws",
    });
    expect(
      await records(USER, "example-provider").read<{ access_token: string }>("tokens", read),
    ).toEqual({
      access_token: "user",
    });
  });

  test("a corrupt record reads as absent rather than throwing", async () => {
    await store.put(
      { kind: "workspace", wsId: "ws_0076759dbbe19fcc" },
      mcpOAuthKey("example-provider", "tokens"),
      "{",
    );
    expect(
      await records(WS, "example-provider").read<{ access_token: string }>("tokens", {
        caller: "test",
        purpose: "assert",
      }),
    ).toBeNull();
  });

  test("has() is a presence probe — it never emits an audit read", async () => {
    await records(WS, "example-provider").write("tokens", { access_token: "a" });
    events.length = 0;

    expect(await records(WS, "example-provider").has("tokens")).toBe(true);
    expect(await records(WS, "other").has("tokens")).toBe(false);
    expect(events.filter((e) => e.type === "audit.credential_read")).toHaveLength(0);
  });

  test("reading a record emits one audit line carrying the caller's purpose", async () => {
    await records(WS, "example-provider").write("tokens", { access_token: "a" });
    events.length = 0;

    await records(WS, "example-provider").read<{ access_token: string }>("tokens", {
      caller: "oauth:tokens",
      purpose: "transport example-provider",
    });

    const audit = events.filter((e) => e.type === "audit.credential_read");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toMatchObject({
      scope: "workspace:ws_0076759dbbe19fcc",
      key: "mcp-oauth.example-provider.tokens",
      caller: "oauth:tokens",
      purpose: "transport example-provider",
    });
  });
});

describe("McpOAuthRecords — teardown", () => {
  test("deleteAll removes every record and leaves neighbours alone", async () => {
    await records(WS, "example-provider").write("tokens", { access_token: "a" });
    await records(WS, "example-provider").write("client", { client_id: "cid" });
    await records(WS, "example-provider").write("verifier", { codeVerifier: "v" });
    await records(WS, "example-provider").write("identity", { email: "a@example.com" });
    // A neighbouring connector's records must survive.
    await records(WS, "other-provider").write("tokens", { access_token: "keep" });

    await records(WS, "example-provider").deleteAll();

    for (const record of ["tokens", "client", "verifier", "identity"] as const) {
      expect(await records(WS, "example-provider").has(record)).toBe(false);
    }
    expect(await records(WS, "other-provider").has("tokens")).toBe(true);
  });
});

describe("hasMcpOAuthTokens", () => {
  test("true only once tokens are stored", async () => {
    expect(await hasMcpOAuthTokens(WS, "example-provider")).toBe(false);
    // A sibling record is not a token record.
    await records(WS, "example-provider").write("client", { client_id: "cid" });
    expect(await hasMcpOAuthTokens(WS, "example-provider")).toBe(false);
    await records(WS, "example-provider").write("tokens", { access_token: "a" });
    expect(await hasMcpOAuthTokens(WS, "example-provider")).toBe(true);
  });
});
