import { describe, expect, it } from "bun:test";
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
  opts: { maxSize?: number; maxUris?: number; rateLimit?: TokenBucketRateLimit } = {},
) {
  return createResourceArgumentsResolver({
    sourcesOf: (wsId) => byWorkspace[wsId] ?? [],
    isHostScheme: isReservedResourceScheme,
    rateLimit: opts.rateLimit ?? new TokenBucketRateLimit(),
    ...(opts.maxSize !== undefined ? { maxSize: opts.maxSize } : {}),
    ...(opts.maxUris !== undefined ? { maxUris: opts.maxUris } : {}),
  });
}

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
    const crm = servingSource("crm", ["crm://signals/{id}"], {
      "crm://signals/42": '{"id":42}',
    });
    const other = servingSource("notes", ["notes://pages/{id}"]);
    const entries = await resolverOver({ [WS_A]: [crm, other] }).resolve(
      [{ uri: "crm://signals/42", declared: true }],
      ctx,
    );
    expect(entries).toEqual({
      "crm://signals/42": {
        contents: [{ uri: "crm://signals/42", mimeType: "application/json", text: '{"id":42}' }],
      },
    });
    expect(other.reads).toEqual([]);
  });

  it("reads nothing, and spends no budget, for a call that may not read resources", async () => {
    const crm = servingSource("crm", ["crm://signals/{id}"], { "crm://signals/42": "{}" });
    const rateLimit = new TokenBucketRateLimit({ burst: 1, ratePerSec: 0.001, now: () => 0 });
    const entries = await resolverOver({ [WS_A]: [crm] }, { rateLimit }).resolve(
      [{ uri: "crm://signals/42", declared: true }],
      { ...ctx, mayRead: false },
    );
    expect(entries["crm://signals/42"]).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
    expect(crm.reads).toEqual([]);
    expect(() => rateLimit.check(WS_A, "outbound")).not.toThrow();
  });

  it("never reads a URI whose scheme is undeclared, and says so", async () => {
    const mail = servingSource("mail", ["mail://inbox/{id}"], { "mail://inbox/9": "secret" });
    const entries = await resolverOver({ [WS_A]: [mail] }).resolve(
      [{ uri: "mail://inbox/9", declared: false }],
      ctx,
    );
    expect(entries["mail://inbox/9"]).toEqual({
      error: { code: "scheme_not_declared", message: expect.any(String) },
    });
    expect(mail.reads).toEqual([]);
  });

  it("passes a URI no connector serves as unresolved, never dropped", async () => {
    const entries = await resolverOver({
      [WS_A]: [servingSource("notes", ["notes://{id}"])],
    }).resolve([{ uri: "crm://signals/1", declared: true }], ctx);
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
    const resolver = resolverOver({ [WS_A]: [failing, empty] });
    const entries = await resolver.resolve(
      [
        { uri: "crm://signals/1", declared: true },
        { uri: "crm2://signals/1", declared: true },
      ],
      ctx,
    );
    expect(entries["crm://signals/1"]).toMatchObject({ error: { code: "not_found" } });
    expect(entries["crm2://signals/1"]).toMatchObject({ error: { code: "not_found" } });
  });

  it("never resolves from a connector in another workspace", async () => {
    const elsewhere = servingSource("crm", ["crm://signals/{id}"], { "crm://signals/1": "{}" });
    const entries = await resolverOver({ [WS_A]: [], [WS_B]: [elsewhere] }).resolve(
      [{ uri: "crm://signals/1", declared: true }],
      ctx,
    );
    expect(entries["crm://signals/1"]).toMatchObject({ error: { code: "not_found" } });
    expect(elsewhere.reads).toEqual([]);
  });

  it("refuses to guess between two connectors that claim the same URI", async () => {
    const a = servingSource("crm-a", ["crm://signals/{id}"], { "crm://signals/1": "a" });
    const b = servingSource("crm-b", ["crm://{+path}"], { "crm://signals/1": "b" });
    const entries = await resolverOver({ [WS_A]: [a, b] }).resolve(
      [{ uri: "crm://signals/1", declared: true }],
      ctx,
    );
    expect(entries["crm://signals/1"]).toMatchObject({ error: { code: "ambiguous" } });
    expect([...a.reads, ...b.reads]).toEqual([]);
  });

  it("lets no connector answer for a scheme the host resolves itself", async () => {
    const squatter = servingSource("squatter", ["files://{id}"], { "files://fl_1": "x" });
    const entries = await resolverOver({ [WS_A]: [squatter] }).resolve(
      [{ uri: "files://fl_1", declared: true }],
      ctx,
    );
    expect(entries["files://fl_1"]).toMatchObject({ error: { code: "not_found" } });
    expect(squatter.reads).toEqual([]);
  });

  it("caps one resource, and one call's contents together, at maxSize", async () => {
    const crm = servingSource("crm", ["crm://signals/{id}"], {
      "crm://signals/big": "x".repeat(11),
      "crm://signals/a": "x".repeat(6),
      "crm://signals/b": "x".repeat(6),
    });
    const entries = await resolverOver({ [WS_A]: [crm] }, { maxSize: 10 }).resolve(
      [
        { uri: "crm://signals/big", declared: true },
        { uri: "crm://signals/a", declared: true },
        { uri: "crm://signals/b", declared: true },
      ],
      ctx,
    );
    expect(entries["crm://signals/big"]).toMatchObject({ error: { code: "too_large" } });
    expect(entries["crm://signals/a"]).toHaveProperty("contents");
    expect(entries["crm://signals/b"]).toMatchObject({ error: { code: "too_large" } });
  });

  it("measures a blob by its decoded bytes", async () => {
    const blob = Buffer.from("0123456789").toString("base64");
    const source: ResourceServingSource = {
      name: "crm",
      resourceTemplates: async () => [{ uriTemplate: "crm://files/{id}" }],
      readResourceContents: async (uri) => [{ uri, mimeType: "application/pdf", blob }],
    };
    const fits = await resolverOver({ [WS_A]: [source] }, { maxSize: 10 }).resolve(
      [{ uri: "crm://files/1", declared: true }],
      ctx,
    );
    expect(fits["crm://files/1"]).toHaveProperty("contents");
  });

  it("resolves at most maxUris per call and marks the rest", async () => {
    const crm = servingSource("crm", ["crm://signals/{id}"], {
      "crm://signals/1": "1",
      "crm://signals/2": "2",
    });
    const entries = await resolverOver({ [WS_A]: [crm] }, { maxUris: 1 }).resolve(
      [
        { uri: "crm://signals/1", declared: true },
        { uri: "crm://signals/2", declared: true },
      ],
      ctx,
    );
    expect(entries["crm://signals/1"]).toHaveProperty("contents");
    expect(entries["crm://signals/2"]).toMatchObject({ error: { code: "too_many" } });
    expect(crm.reads).toEqual(["crm://signals/1"]);
  });

  it("spends the calling connector's host-resources budget, one token per read", async () => {
    const crm = servingSource("crm", ["crm://signals/{id}"], {
      "crm://signals/1": "1",
      "crm://signals/2": "2",
    });
    const rateLimit = new TokenBucketRateLimit({ burst: 1, ratePerSec: 0.001, now: () => 0 });
    const entries = await resolverOver({ [WS_A]: [crm] }, { rateLimit }).resolve(
      [
        { uri: "crm://signals/1", declared: true },
        { uri: "crm://signals/2", declared: true },
      ],
      ctx,
    );
    const codes = Object.values(entries).map((e) => ("error" in e ? e.error.code : "ok"));
    expect(codes.sort()).toEqual(["ok", "rate_limited"]);
  });
});
