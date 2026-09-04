import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineEvent } from "../../../src/engine/types.ts";
import type { CredentialStore } from "../../../src/tools/credential-store.ts";
import {
  hasMcpOAuthTokens,
  legacyMcpOAuthDir,
  McpOAuthRecords,
  mcpOAuthKey,
} from "../../../src/tools/mcp-oauth-records.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../../helpers/credential-store.ts";

const WS = { type: "workspace", wsId: "ws_test" } as const;
const USER = { type: "user", userId: "usr_alice" } as const;

let workDir: string;
let store: CredentialStore;
let events: EngineEvent[];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-oauth-records-"));
  events = [];
  store = installTestCredentialStore(workDir, events);
});

afterEach(() => {
  resetTestCredentialStore();
  rmSync(workDir, { recursive: true, force: true });
});

/** Plant a pre-store record where the old file layout kept it. */
function plantLegacy(
  owner: typeof WS | typeof USER,
  serverName: string,
  record: string,
  value: unknown,
  root = workDir,
): string {
  const dir = legacyMcpOAuthDir(root, owner, serverName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function records(owner: typeof WS | typeof USER, serverName: string): McpOAuthRecords {
  return new McpOAuthRecords({ owner, serverName, workDir });
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
      { kind: "workspace", wsId: "ws_test" },
      mcpOAuthKey("example-provider", "tokens"),
      { caller: "test", purpose: "assert" },
    );
    expect(JSON.parse(stored?.reveal() ?? "null")).toEqual({ access_token: "a" });
    expect(await records(WS, "example-provider").read("tokens", { caller: "test", purpose: "assert" })).toEqual(
      { access_token: "a" },
    );
  });

  test("workspace and user scope hold independent records under the same key", async () => {
    await records(WS, "example-provider").write("tokens", { access_token: "ws" });
    await records(USER, "example-provider").write("tokens", { access_token: "user" });

    const read = { caller: "test", purpose: "assert" } as const;
    expect(await records(WS, "example-provider").read("tokens", read)).toEqual({ access_token: "ws" });
    expect(await records(USER, "example-provider").read("tokens", read)).toEqual({ access_token: "user" });
  });

  test("a corrupt record reads as absent rather than throwing", async () => {
    await store.put({ kind: "workspace", wsId: "ws_test" }, mcpOAuthKey("example-provider", "tokens"), "{");
    expect(
      await records(WS, "example-provider").read("tokens", { caller: "test", purpose: "assert" }),
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

    await records(WS, "example-provider").read("tokens", {
      caller: "oauth:tokens",
      purpose: "transport example-provider",
    });

    const audit = events.filter((e) => e.type === "audit.credential_read");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toMatchObject({
      scope: "workspace:ws_test",
      key: "mcp-oauth.example-provider.tokens",
      caller: "oauth:tokens",
      purpose: "transport example-provider",
    });
  });
});

describe("McpOAuthRecords — legacy import", () => {
  test("a legacy file is imported on first read and removed", async () => {
    const path = plantLegacy(WS, "example-provider", "tokens", { access_token: "legacy" });

    const value = await records(WS, "example-provider").read("tokens", {
      caller: "test",
      purpose: "assert",
    });

    expect(value).toEqual({ access_token: "legacy" });
    expect(existsSync(path)).toBe(false);
    const stored = await store.get(
      { kind: "workspace", wsId: "ws_test" },
      mcpOAuthKey("example-provider", "tokens"),
      { caller: "test", purpose: "assert" },
    );
    expect(JSON.parse(stored?.reveal() ?? "null")).toEqual({ access_token: "legacy" });
  });

  test("the whole legacy tree is gone once the last record crosses over", async () => {
    plantLegacy(WS, "example-provider", "tokens", { access_token: "legacy" });
    plantLegacy(WS, "example-provider", "client", { client_id: "cid" });
    const read = { caller: "test", purpose: "assert" } as const;

    await records(WS, "example-provider").read("tokens", read);
    await records(WS, "example-provider").read("client", read);

    expect(existsSync(legacyMcpOAuthDir(workDir, WS, "example-provider"))).toBe(false);
    expect(
      existsSync(join(workDir, "workspaces", "ws_test", "credentials", "mcp-oauth")),
    ).toBe(false);
  });

  test("a stored key wins over a legacy file — no silent downgrade", async () => {
    await records(WS, "example-provider").write("tokens", { access_token: "current" });
    plantLegacy(WS, "example-provider", "tokens", { access_token: "stale" });

    expect(
      await records(WS, "example-provider").read("tokens", { caller: "test", purpose: "assert" }),
    ).toEqual({ access_token: "current" });
  });

  test("a write retires the legacy file it supersedes — the record read never reaches", async () => {
    // `saveCodeVerifier` sets the verifier before anything reads it, so the
    // import in `read` never runs for this record. The plaintext file has to go
    // on the write instead, or it outlives the value it held.
    const path = plantLegacy(WS, "example-provider", "verifier", { codeVerifier: "old" });

    await records(WS, "example-provider").write("verifier", { codeVerifier: "new" });

    expect(existsSync(path)).toBe(false);
    expect(existsSync(legacyMcpOAuthDir(workDir, WS, "example-provider"))).toBe(false);
    expect(
      await records(WS, "example-provider").read("verifier", { caller: "test", purpose: "assert" }),
    ).toEqual({ codeVerifier: "new" });
  });

  test("a user-scope legacy file imports to user scope", async () => {
    plantLegacy(USER, "example-provider", "tokens", { access_token: "legacy" });

    expect(await hasMcpOAuthTokens(workDir, USER, "example-provider")).toBe(true);
    const stored = await store.get(
      { kind: "user", userId: "usr_alice" },
      mcpOAuthKey("example-provider", "tokens"),
      { caller: "test", purpose: "assert" },
    );
    expect(JSON.parse(stored?.reveal() ?? "null")).toEqual({ access_token: "legacy" });
  });

  test("the legacy root is the workDir passed in, not whatever the store is rooted at", async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "nb-oauth-other-"));
    try {
      plantLegacy(WS, "example-provider", "tokens", { access_token: "elsewhere" }, otherRoot);
      expect(await hasMcpOAuthTokens(workDir, WS, "example-provider")).toBe(false);
      expect(await hasMcpOAuthTokens(otherRoot, WS, "example-provider")).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

describe("McpOAuthRecords — teardown", () => {
  test("deleteAll removes every record and any legacy leftovers", async () => {
    await records(WS, "example-provider").write("tokens", { access_token: "a" });
    await records(WS, "example-provider").write("client", { client_id: "cid" });
    await records(WS, "example-provider").write("verifier", { codeVerifier: "v" });
    await records(WS, "example-provider").write("identity", { email: "a@example.com" });
    // Never read, so never imported — teardown must still take it.
    plantLegacy(WS, "example-provider", "identity", { email: "old@example.com" });
    // A neighbouring connector's records must survive.
    await records(WS, "other-provider").write("tokens", { access_token: "keep" });

    await records(WS, "example-provider").deleteAll();

    for (const record of ["tokens", "client", "verifier", "identity"] as const) {
      expect(await records(WS, "example-provider").has(record)).toBe(false);
    }
    expect(existsSync(legacyMcpOAuthDir(workDir, WS, "example-provider"))).toBe(false);
    expect(await records(WS, "other-provider").has("tokens")).toBe(true);
  });
});

describe("hasMcpOAuthTokens", () => {
  test("true only once tokens are stored", async () => {
    expect(await hasMcpOAuthTokens(workDir, WS, "example-provider")).toBe(false);
    // A sibling record is not a token record.
    await records(WS, "example-provider").write("client", { client_id: "cid" });
    expect(await hasMcpOAuthTokens(workDir, WS, "example-provider")).toBe(false);
    await records(WS, "example-provider").write("tokens", { access_token: "a" });
    expect(await hasMcpOAuthTokens(workDir, WS, "example-provider")).toBe(true);
  });
});
