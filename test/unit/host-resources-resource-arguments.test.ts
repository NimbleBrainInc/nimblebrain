import { describe, expect, it } from "bun:test";
import type { ReadResourceResult } from "@modelcontextprotocol/server";
import {
  collectResourceArgumentUris,
  createResourceArgumentsResolver,
  parseResourceArgumentsDeclaration,
  RESOURCE_ARGUMENTS_EXTENSION_ID,
  type ResourceServingSource,
  TokenBucketRateLimit,
} from "../../src/host-resources/index.ts";
import { isReservedResourceScheme } from "../../src/tools/resource-schemes.ts";

const WS_A = "ws_0000000000000a01";
const WS_B = "ws_0000000000000b02";

/** A connector serving `templates`, answering reads from `records`, counting every read. */
function servingSource(
  name: string,
  templates: string[],
  records: Record<string, string> = {},
): ResourceServingSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    name,
    reads,
    resourceTemplates: async () => templates.map((uriTemplate) => ({ uriTemplate })),
    readResourceContents: async (uri) => {
      reads.push(uri);
      const text = records[uri];
      return text === undefined ? null : [{ uri, mimeType: "application/json", text }];
    },
  };
}

function resolverOver(
  byWorkspace: Record<string, ResourceServingSource[]>,
  opts: {
    maxChars?: number;
    maxSize?: number;
    maxUris?: number;
    rateLimit?: TokenBucketRateLimit;
  } = {},
) {
  const resolver = createResourceArgumentsResolver({
    sourcesOf: (wsId) => byWorkspace[wsId] ?? [],
    isHostScheme: isReservedResourceScheme,
    rateLimit: opts.rateLimit ?? new TokenBucketRateLimit(),
    maxChars: opts.maxChars ?? 1000,
    ...(opts.maxSize !== undefined ? { maxSize: opts.maxSize } : {}),
    ...(opts.maxUris !== undefined ? { maxUris: opts.maxUris } : {}),
  });
  return {
    /** The entries a call carries. */
    resolve: async (uris: { uri: string; declared: boolean }[]) =>
      (await resolver.resolve(uris, ctx)).entries,
    /** The audit records of the same resolution. */
    resolutions: async (uris: { uri: string; declared: boolean }[]) =>
      (await resolver.resolve(uris, ctx)).resolutions,
  };
}

/** A connector whose every read answers `contents`. */
function answering(
  name: string,
  template: string,
  contents: (uri: string) => ReadResourceResult["contents"],
): ResourceServingSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    name,
    reads,
    resourceTemplates: async () => [{ uriTemplate: template }],
    readResourceContents: async (uri) => {
      reads.push(uri);
      return contents(uri);
    },
  };
}

const declared = (...uris: string[]) => uris.map((uri) => ({ uri, declared: true }));

const ctx = { workspaceId: WS_A, connectorId: "outbound" };

describe("parseResourceArgumentsDeclaration", () => {
  it("reads each argument's schemes, lowercased", () => {
    const declared = parseResourceArgumentsDeclaration({
      [RESOURCE_ARGUMENTS_EXTENSION_ID]: {
        arguments: { citations: { schemes: ["CRM", "notes"] } },
      },
    });
    expect(declared?.get("citations")).toEqual(new Set(["crm", "notes"]));
  });

  it("declares nothing without a non-empty list of valid schemes: there is no wildcard", () => {
    expect(parseResourceArgumentsDeclaration(undefined)).toBeNull();
    expect(parseResourceArgumentsDeclaration({ other: {} })).toBeNull();
    expect(
      parseResourceArgumentsDeclaration({
        [RESOURCE_ARGUMENTS_EXTENSION_ID]: {
          arguments: {
            a: { schemes: [] },
            b: { schemes: ["*"] },
            c: { schemes: "crm" },
            d: "crm",
          },
        },
      }),
    ).toBeNull();
  });
});

describe("collectResourceArgumentUris", () => {
  const declaration = parseResourceArgumentsDeclaration({
    [RESOURCE_ARGUMENTS_EXTENSION_ID]: {
      arguments: { citation: { schemes: ["crm"] }, citations: { schemes: ["crm"] } },
    },
  });
  if (!declaration) throw new Error("fixture declares nothing");

  it("takes strings and arrays of strings from declared arguments only, deduplicated", () => {
    const uris = collectResourceArgumentUris(declaration, {
      citation: "crm://signals/1",
      citations: ["crm://signals/1", "crm://signals/2", 7, ""],
      body: "crm://signals/3",
    });
    expect(uris).toEqual([
      { uri: "crm://signals/1", declared: true },
      { uri: "crm://signals/2", declared: true },
    ]);
  });

  it("marks a value whose scheme the argument does not declare", () => {
    const uris = collectResourceArgumentUris(declaration, {
      citations: ["mail://inbox/9", "not a uri"],
    });
    expect(uris).toEqual([
      { uri: "mail://inbox/9", declared: false },
      { uri: "not a uri", declared: false },
    ]);
  });
});

describe("createResourceArgumentsResolver", () => {
  it("reads a declared URI from the connector whose template it expands from", async () => {
    const crm = servingSource("crm", ["crm://signals/{id}"], { "crm://signals/42": '{"id":42}' });
    const other = servingSource("notes", ["notes://pages/{id}"]);
    const entries = await resolverOver({ [WS_A]: [crm, other] }).resolve(
      declared("crm://signals/42"),
    );
    expect(entries).toEqual({
      "crm://signals/42": {
        contents: [{ uri: "crm://signals/42", mimeType: "application/json", text: '{"id":42}' }],
      },
    });
    expect(other.reads).toEqual([]);
  });

  it("never reads a URI whose scheme is undeclared, and says so", async () => {
    const mail = servingSource("mail", ["mail://inbox/{id}"], { "mail://inbox/9": "secret" });
    const entries = await resolverOver({ [WS_A]: [mail] }).resolve([
      { uri: "mail://inbox/9", declared: false },
    ]);
    expect(entries["mail://inbox/9"]).toEqual({
      error: { code: "scheme_not_declared", message: expect.any(String) },
    });
    expect(mail.reads).toEqual([]);
  });

  it("passes a URI no connector serves as unresolved, never dropped", async () => {
    const entries = await resolverOver({
      [WS_A]: [servingSource("notes", ["notes://{id}"])],
    }).resolve(declared("crm://signals/1"));
    expect(entries["crm://signals/1"]).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });

  it("passes a read that fails or returns nothing as unresolved", async () => {
    const failing: ResourceServingSource = {
      name: "crm",
      resourceTemplates: async () => [{ uriTemplate: "crm://signals/{id}" }],
      readResourceContents: async () => {
        throw new Error("upstream 500");
      },
    };
    const empty = servingSource("crm2", ["crm2://signals/{id}"]);
    const entries = await resolverOver({ [WS_A]: [failing, empty] }).resolve(
      declared("crm://signals/1", "crm2://signals/1"),
    );
    expect(entries["crm://signals/1"]).toMatchObject({ error: { code: "not_found" } });
    expect(entries["crm2://signals/1"]).toMatchObject({ error: { code: "not_found" } });
  });

  it("never resolves from a connector in another workspace", async () => {
    const elsewhere = servingSource("crm", ["crm://signals/{id}"], { "crm://signals/1": "{}" });
    const entries = await resolverOver({ [WS_A]: [], [WS_B]: [elsewhere] }).resolve(
      declared("crm://signals/1"),
    );
    expect(entries["crm://signals/1"]).toMatchObject({ error: { code: "not_found" } });
    expect(elsewhere.reads).toEqual([]);
  });

  it("refuses to guess between two connectors that claim the same URI", async () => {
    const a = servingSource("crm-a", ["crm://signals/{id}"], { "crm://signals/1": "a" });
    const b = servingSource("crm-b", ["crm://{+path}"], { "crm://signals/1": "b" });
    const entries = await resolverOver({ [WS_A]: [a, b] }).resolve(declared("crm://signals/1"));
    expect(entries["crm://signals/1"]).toMatchObject({ error: { code: "ambiguous" } });
    expect([...a.reads, ...b.reads]).toEqual([]);
  });

  it("lets no connector answer for a scheme the host resolves itself", async () => {
    const squatter = servingSource("squatter", ["files://{id}"], { "files://fl_1": "x" });
    const entries = await resolverOver({ [WS_A]: [squatter] }).resolve(declared("files://fl_1"));
    expect(entries["files://fl_1"]).toMatchObject({ error: { code: "not_found" } });
    expect(squatter.reads).toEqual([]);
  });

  it("hands on text only: a blob, alone or beside text, is not_text and its bytes never pass", async () => {
    const blob = Buffer.from("%PDF-1.7").toString("base64");
    const files = answering("crm", "crm://files/{id}", (uri) =>
      uri.endsWith("/mixed")
        ? [
            { uri, mimeType: "text/plain", text: "caption" },
            { uri, mimeType: "application/pdf", blob },
          ]
        : [{ uri, mimeType: "application/pdf", blob }],
    );
    const entries = await resolverOver({ [WS_A]: [files] }).resolve(
      declared("crm://files/pdf", "crm://files/mixed"),
    );
    expect(entries["crm://files/pdf"]).toMatchObject({ error: { code: "not_text" } });
    expect(entries["crm://files/mixed"]).toMatchObject({ error: { code: "not_text" } });
    expect(JSON.stringify(entries)).not.toContain(blob);
  });

  it("caps each resource at the agent's read limit: over it is too_large, never cut", async () => {
    const crm = servingSource("crm", ["crm://signals/{id}"], {
      "crm://signals/fits": "x".repeat(10),
      "crm://signals/over": "x".repeat(11),
    });
    const entries = await resolverOver({ [WS_A]: [crm] }, { maxChars: 10 }).resolve(
      declared("crm://signals/fits", "crm://signals/over"),
    );
    expect(entries["crm://signals/fits"]).toHaveProperty("contents");
    expect(entries["crm://signals/over"]).toEqual({
      error: { code: "too_large", message: expect.any(String) },
    });
  });

  it("caps a call's contents together, refusing before reading or spending budget", async () => {
    // Each read reserves maxChars × 3 bytes = 30; a 60-byte call admits two.
    const crm = servingSource("crm", ["crm://signals/{id}"], {
      "crm://signals/1": "a",
      "crm://signals/2": "b",
      "crm://signals/3": "c",
    });
    const rateLimit = new TokenBucketRateLimit({ burst: 3, ratePerSec: 0.001, now: () => 0 });
    const entries = await resolverOver(
      { [WS_A]: [crm] },
      { maxChars: 10, maxSize: 60, rateLimit },
    ).resolve(declared("crm://signals/1", "crm://signals/2", "crm://signals/3"));
    expect(entries["crm://signals/1"]).toHaveProperty("contents");
    expect(entries["crm://signals/2"]).toHaveProperty("contents");
    expect(entries["crm://signals/3"]).toMatchObject({ error: { code: "too_large" } });
    expect(crm.reads).toEqual(["crm://signals/1", "crm://signals/2"]);
    expect(() => rateLimit.check(WS_A, "outbound")).not.toThrow();
  });

  it("resolves at most maxUris per call and marks the rest", async () => {
    const crm = servingSource("crm", ["crm://signals/{id}"], {
      "crm://signals/1": "1",
      "crm://signals/2": "2",
    });
    const entries = await resolverOver({ [WS_A]: [crm] }, { maxUris: 1 }).resolve(
      declared("crm://signals/1", "crm://signals/2"),
    );
    expect(entries["crm://signals/1"]).toHaveProperty("contents");
    expect(entries["crm://signals/2"]).toMatchObject({ error: { code: "too_many" } });
    expect(crm.reads).toEqual(["crm://signals/1"]);
  });

  it("spends one token per read made, and none on a URI no connector serves", async () => {
    const crm = servingSource("crm", ["crm://signals/{id}"], {
      "crm://signals/1": "1",
      "crm://signals/2": "2",
    });
    const rateLimit = new TokenBucketRateLimit({ burst: 1, ratePerSec: 0.001, now: () => 0 });
    const entries = await resolverOver({ [WS_A]: [crm] }, { rateLimit }).resolve(
      declared("nobody://x/1", "crm://signals/1", "crm://signals/2"),
    );
    expect(entries["nobody://x/1"]).toMatchObject({ error: { code: "not_found" } });
    const codes = ["crm://signals/1", "crm://signals/2"].map((u) => {
      const e = entries[u];
      return e && "error" in e ? e.error.code : "ok";
    });
    expect(codes.sort()).toEqual(["ok", "rate_limited"]);
  });

  it("records each URI's outcome for the audit trail, in argument order, never its contents", async () => {
    const crm = servingSource("crm", ["crm://signals/{id}"], { "crm://signals/1": "héllo" });
    const resolutions = await resolverOver({ [WS_A]: [crm] }).resolutions([
      { uri: "crm://signals/1", declared: true },
      { uri: "crm://signals/9", declared: true },
      { uri: "mail://inbox/1", declared: false },
    ]);
    expect(resolutions).toEqual([
      { uri: "crm://signals/1", source: "crm", outcome: "resolved", bytes: 6 },
      { uri: "crm://signals/9", source: "crm", outcome: "not_found", bytes: 0 },
      { uri: "mail://inbox/1", outcome: "scheme_not_declared", bytes: 0 },
    ]);
    expect(JSON.stringify(resolutions)).not.toContain("héllo");
  });

  it("advertises its limits", () => {
    const resolver = createResourceArgumentsResolver({
      sourcesOf: () => [],
      isHostScheme: () => false,
      rateLimit: new TokenBucketRateLimit(),
      maxChars: 500,
    });
    expect(resolver.limits).toEqual({ maxChars: 500, maxSize: 10 * 1024 * 1024, maxUris: 32 });
  });
});
