import { beforeEach, describe, expect, it } from "bun:test";
import { ProtocolError } from "@modelcontextprotocol/server";
import { hostExtensions } from "../../src/host-resources/capability.ts";
import {
  FilesHostResourcesResolver,
  HOST_RESOURCES_CAPABILITY_KEY,
  type HostResourceContext,
} from "../../src/host-resources/index.ts";
import { createFakeFilesHost, type FakeFilesHost } from "../helpers/fake-files-host.ts";
import { blobOf, textOf } from "../helpers/resource-contents.ts";

// The resolver is the one chokepoint between a connector's inbound
// host-resources request and the files contract: `resolve` and `list` as
// `host`, walled to the connector's workspace (`ctx.workspaceId`) and the user
// its tool call was made for (`ctx.ownerId`). The URI carries only the id.

const RESOURCE_NOT_FOUND = -32602;
const INVALID_PARAMS = -32602;

const ctxA: HostResourceContext = {
  workspaceId: "ws_00079598e311c160",
  connectorId: "connector_x",
  ownerId: "user-a",
};
const ctxB: HostResourceContext = { ...ctxA, workspaceId: "ws_001c32f121060ff3" };

let files: FakeFilesHost;
let resolver: FilesHostResourcesResolver;

function seed(ctx: HostResourceContext, name: string, body: string | Uint8Array, mime: string) {
  return files.seed(
    { workspaceId: ctx.workspaceId, ownerId: ctx.ownerId },
    { filename: name, mimeType: mime, body },
  ).id;
}

async function codeOf(p: Promise<unknown>): Promise<{ code: number; data: unknown }> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProtocolError);
    const e = err as ProtocolError;
    return { code: e.code, data: e.data };
  }
  throw new Error("expected a ProtocolError");
}

beforeEach(() => {
  files = createFakeFilesHost();
  resolver = new FilesHostResourcesResolver(() => files);
});

describe("FilesHostResourcesResolver.read", () => {
  it("returns text contents for a text type and a base64 blob otherwise", async () => {
    const text = seed(ctxA, "a.csv", "a,b", "text/csv");
    const bin = seed(ctxA, "p.png", new Uint8Array([1, 2, 3]), "image/png");
    expect(textOf((await resolver.read(`files://${text}`, ctxA)).contents[0])).toBe("a,b");
    expect(blobOf((await resolver.read(`files://${bin}`, ctxA)).contents[0])).toBe(
      Buffer.from([1, 2, 3]).toString("base64"),
    );
  });

  it("resolves as the call's own owner in the connector's workspace", async () => {
    const id = seed(ctxA, "a.txt", "x", "text/plain");
    await resolver.read(`files://${id}`, ctxA);
    expect(files.calls.at(-1)).toMatchObject({
      tool: "resolve",
      scope: { workspaceId: ctxA.workspaceId, ownerId: "user-a" },
    });
  });

  it("answers not found for another workspace's file and another owner's", async () => {
    const id = seed(ctxA, "a.txt", "x", "text/plain");
    for (const ctx of [ctxB, { ...ctxA, ownerId: "user-b" }]) {
      const got = await codeOf(resolver.read(`files://${id}`, ctx));
      expect(got.code).toBe(RESOURCE_NOT_FOUND);
      expect(got.data).toEqual({ uri: `files://${id}` });
    }
  });

  it("refuses a scheme other than files", async () => {
    const got = await codeOf(resolver.read("entities://x", ctxA));
    expect(got.code).toBe(INVALID_PARAMS);
    expect(got.data).toMatchObject({ supported: ["files"] });
  });

  it("answers response-too-large past the read cap, before fetching the body", async () => {
    const small = new FilesHostResourcesResolver(() => files, 2);
    const id = seed(ctxA, "a.txt", "hello", "text/plain");
    const got = await codeOf(small.read(`files://${id}`, ctxA));
    expect(got.code).toBe(-32005);
  });
});

describe("FilesHostResourcesResolver.list", () => {
  it("follows the plugin's cursor to the end, with an exact type filter", async () => {
    for (let i = 0; i < 230; i++) seed(ctxA, `f${i}.md`, "x", i % 2 ? "text/markdown" : "text/csv");
    const all = await resolver.list({}, ctxA);
    expect(all.resources).toHaveLength(230);
    expect(files.calls.filter((c) => c.tool === "list")).toHaveLength(3);
    const md = await resolver.list({ filter: { mimeType: "text/markdown" } }, ctxA);
    expect(md.resources).toHaveLength(115);
  });

  it("filters by every tag named, and refuses a tags filter that is not an array", async () => {
    files.seed(
      { workspaceId: ctxA.workspaceId, ownerId: ctxA.ownerId },
      { filename: "d.md", mimeType: "text/markdown", body: "x", tags: ["draft"] },
    );
    seed(ctxA, "e.md", "y", "text/markdown");
    expect((await resolver.list({ filter: { tags: ["draft"] } }, ctxA)).resources).toHaveLength(1);
    const filter = JSON.parse('{"tags":"draft"}') as { tags: string[] };
    const bad = await codeOf(resolver.list({ filter }, ctxA));
    expect(bad.code).toBe(INVALID_PARAMS);
  });

  it("refuses an unsupported scheme filter and a cursor", async () => {
    expect((await codeOf(resolver.list({ filter: { scheme: "x" } }, ctxA))).code).toBe(
      INVALID_PARAMS,
    );
    expect((await codeOf(resolver.list({ cursor: "abc" }, ctxA))).code).toBe(INVALID_PARAMS);
  });
});

describe("with no files plugin bound", () => {
  it("serves no scheme, refuses every request, and the capability advertises none", async () => {
    const off = new FilesHostResourcesResolver(() => null);
    expect(off.schemes()).toEqual([]);
    expect((await codeOf(off.read("files://fl_x", ctxA))).code).toBe(INVALID_PARAMS);
    expect((await codeOf(off.list({}, ctxA))).code).toBe(INVALID_PARAMS);
    const caps = hostExtensions(off.schemes())[HOST_RESOURCES_CAPABILITY_KEY] as {
      schemes: string[];
    };
    expect(caps.schemes).toEqual([]);
  });
});
