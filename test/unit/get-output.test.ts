import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createFileStore, type FileStore } from "../../src/files/store.ts";
import { createLocalOutputStore, type OutputScope } from "../../src/files/output-store.ts";
import { createGetOutputTool, resolveOutputResource } from "../../src/tools/get-output.ts";
import type { ToolResult } from "../../src/engine/types.ts";

/** Extract the first text content block from a tool result. */
function textOf(res: ToolResult): string {
  return (res.content[0] as { text: string }).text;
}

const WS = "ws_alpha";
const OTHER_WS = "ws_beta";

describe("nb__get_output", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "get-output-"));
    store = createFileStore(join(dir, "files"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A single shared local store backs both workspaces here; the tool fences by
  // the CURRENT workspace (defense in depth — a real workspace-scoped store is
  // already rooted under the workspace dir).
  function outputStore() {
    return createLocalOutputStore({ resolveStore: (_s: OutputScope) => store });
  }

  it("returns a >12K stored output in FULL (no truncation)", async () => {
    const out = outputStore();
    const big = "y".repeat(13_500) + "END_SENTINEL";
    const ref = await out.put({ workspace: WS }, { kind: "report", mime: "text/markdown", body: big });

    const tool = createGetOutputTool({ getWorkspaceId: () => WS, store: out });
    const res = await tool.handler({ ref: ref.uri });

    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text.length).toBe(big.length);
    expect(text.endsWith("END_SENTINEL")).toBe(true);
    expect(text).not.toContain("truncated");
  });

  it("accepts a bare id as well as a files:// ref", async () => {
    const out = outputStore();
    const ref = await out.put({ workspace: WS }, { kind: "report", mime: "text/plain", body: "hello" });
    const tool = createGetOutputTool({ getWorkspaceId: () => WS, store: out });

    const res = await tool.handler({ ref: ref.id });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("hello");
  });

  it("denies a ref produced under another workspace (no cross-workspace read)", async () => {
    const out = outputStore();
    // Written under OTHER_WS …
    const ref = await out.put({ workspace: OTHER_WS }, { kind: "report", mime: "text/plain", body: "secret" });
    // … requested from WS.
    const tool = createGetOutputTool({ getWorkspaceId: () => WS, store: out });

    const res = await tool.handler({ ref: ref.uri });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).not.toContain("secret"); // no leakage of the body
    expect(text).toContain("not found");
  });

  it("returns a clean not-found for an unknown ref (no stack trace)", async () => {
    const out = outputStore();
    const tool = createGetOutputTool({ getWorkspaceId: () => WS, store: out });

    const res = await tool.handler({ ref: "files://fl_does_not_exist" });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
    expect(text).not.toContain("at ");
  });

  it("rejects a non-files scheme without touching the store", async () => {
    const out = outputStore();
    const tool = createGetOutputTool({ getWorkspaceId: () => WS, store: out });

    const res = await tool.handler({ ref: "skill://foo/bar" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("not an output reference");
  });

  it("fails cleanly when no workspace is bound", async () => {
    const out = outputStore();
    const ref = await out.put({ workspace: WS }, { kind: "report", mime: "text/plain", body: "x" });
    const tool = createGetOutputTool({ getWorkspaceId: () => null, store: out });

    const res = await tool.handler({ ref: ref.uri });
    expect(res.isError).toBe(true);
  });
});

// The `nb` system source resolves `files://<id>` output refs through this same
// helper (wired as its `resourceHandler`), so a deep_research `resource_link`
// peeks via read_resource. These cover the resolver directly.
describe("resolveOutputResource (nb resource handler)", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "resolve-output-"));
    store = createFileStore(join(dir, "files"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function outputStore() {
    return createLocalOutputStore({ resolveStore: (_s: OutputScope) => store });
  }

  it("resolves a stored text output to an InProcessResource", async () => {
    const out = outputStore();
    const ref = await out.put(
      { workspace: WS },
      { kind: "report", mime: "text/markdown", body: "# Title\nbody text" },
    );
    const res = await resolveOutputResource(out, WS, ref.uri);
    expect(res).not.toBeNull();
    expect((res as { text: string }).text).toContain("body text");
  });

  it("returns null for a foreign-workspace ref (no leak)", async () => {
    const out = outputStore();
    const ref = await out.put(
      { workspace: OTHER_WS },
      { kind: "report", mime: "text/plain", body: "secret body" },
    );
    expect(await resolveOutputResource(out, WS, ref.uri)).toBeNull();
  });

  it("returns null for a non-files scheme", async () => {
    expect(await resolveOutputResource(outputStore(), WS, "skill://foo/bar")).toBeNull();
  });

  it("returns null with no bound workspace", async () => {
    const out = outputStore();
    const ref = await out.put({ workspace: WS }, { kind: "report", mime: "text/plain", body: "x" });
    expect(await resolveOutputResource(out, null, ref.uri)).toBeNull();
  });

  it("returns null for an unknown files:// ref (no crash)", async () => {
    expect(await resolveOutputResource(outputStore(), WS, "files://fl_missing")).toBeNull();
  });
});
