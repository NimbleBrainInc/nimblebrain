import { afterEach, describe, expect, it } from "bun:test";
import { artifactResolutionsTotal } from "../../../src/api/metrics.ts";
import type { ToolResult } from "../../../src/engine/types.ts";
import type { ArtifactResolver } from "../../../src/host-resources/artifacts/artifact-resolver.ts";
import {
  ArtifactNotFoundError,
  ArtifactTooLargeError,
  InvalidArtifactUriError,
  setArtifactResolver,
} from "../../../src/host-resources/artifacts/index.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import { createCoreToolDefs } from "../../../src/tools/core-source.ts";
import { stub } from "../../helpers/stub.ts";

// Behavioral tests for the read_artifact / list_artifacts core tool HANDLERS
// (the client + persistence are covered in artifact-resolver.test.ts and
// event-sourced-store.test.ts). We drive the real handlers with a minimal mock
// runtime (only requireWorkspaceId is exercised) and a fake resolver injected
// through the setArtifactResolver test seam — so the uri normalization, the
// contents→text extraction, the not-found mapping, and the list formatting are
// all under test, not just the data-plane plumbing.

const WS = "ws_0076759dbbe19fcc";
const runtime = stub<Runtime>({ requireWorkspaceId: () => WS });

function handlerFor(name: string): (input: Record<string, unknown>) => Promise<ToolResult> {
  const tool = createCoreToolDefs(runtime).find((d) => d.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler;
}

function firstText(res: ToolResult): string {
  const block = res.content[0];
  return block?.type === "text" ? block.text : "";
}

afterEach(() => setArtifactResolver(undefined));

describe("read_artifact tool handler", () => {
  it("reads a text artifact, normalizing a bare id to artifact://", async () => {
    let seen: { uri: string; ws: string } | undefined;
    setArtifactResolver(
      stub<ArtifactResolver>({
        read: async (uri: string, ws: string) => {
          seen = { uri, ws };
          return { contents: [{ uri, mimeType: "text/markdown", text: "# Report\nbody" }] };
        },
      }),
    );

    const res = await handlerFor("read_artifact")({ uri: "art_1" });
    expect(res.isError).toBeFalsy();
    expect(firstText(res)).toBe("# Report\nbody");
    // bare id was normalized to an artifact:// URI, and the verified ws passed through
    expect(seen).toEqual({ uri: "artifact://art_1", ws: WS });
  });

  it("passes an explicit artifact:// uri through unchanged", async () => {
    let seenUri = "";
    setArtifactResolver(
      stub<ArtifactResolver>({
        read: async (uri: string) => {
          seenUri = uri;
          return { contents: [{ uri, mimeType: "text/markdown", text: "x" }] };
        },
      }),
    );
    await handlerFor("read_artifact")({ uri: "artifact://art_9" });
    expect(seenUri).toBe("artifact://art_9");
  });

  it("renders a binary placeholder for non-text contents", async () => {
    setArtifactResolver(
      stub<ArtifactResolver>({
        read: async (uri: string) => ({
          contents: [{ uri, mimeType: "application/pdf", blob: "AAAA" }],
        }),
      }),
    );
    const res = await handlerFor("read_artifact")({ uri: "art_pdf" });
    expect(firstText(res)).toMatch(/binary artifact/);
    expect(firstText(res)).toMatch(/application\/pdf/);
  });

  it("maps ArtifactNotFoundError to a clean not-found result", async () => {
    setArtifactResolver(
      stub<ArtifactResolver>({
        read: async () => {
          throw new ArtifactNotFoundError("art_x");
        },
      }),
    );
    const res = await handlerFor("read_artifact")({ uri: "artifact://art_x" });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toMatch(/not found in this workspace/i);
  });

  // The tool path mirrors the UI read path's metric label granularity: malformed
  // (client/model input) and too_large (over-cap body) are distinct outcomes,
  // not `error`. Deltas, since the counter is a process-global singleton.
  async function resolutionCount(result: string): Promise<number> {
    const metric = await artifactResolutionsTotal.get();
    return metric.values.find((v) => v.labels.result === result)?.value ?? 0;
  }

  it("maps a malformed uri to result=malformed (not error)", async () => {
    const before = await resolutionCount("malformed");
    const errBefore = await resolutionCount("error");
    setArtifactResolver(
      stub<ArtifactResolver>({
        read: async (uri: string) => {
          throw new InvalidArtifactUriError(uri, "id must match the safe-id grammar");
        },
      }),
    );
    const res = await handlerFor("read_artifact")({ uri: "artifact://bad id" });
    expect(res.isError).toBe(true);
    expect(await resolutionCount("malformed")).toBe(before + 1);
    expect(await resolutionCount("error")).toBe(errBefore); // not folded into error
  });

  it("maps an over-cap body to result=too_large (not error)", async () => {
    const before = await resolutionCount("too_large");
    const errBefore = await resolutionCount("error");
    setArtifactResolver(
      stub<ArtifactResolver>({
        read: async () => {
          throw new ArtifactTooLargeError(99, 8);
        },
      }),
    );
    const res = await handlerFor("read_artifact")({ uri: "artifact://art_big" });
    expect(res.isError).toBe(true);
    expect(await resolutionCount("too_large")).toBe(before + 1);
    expect(await resolutionCount("error")).toBe(errBefore);
  });

  it("requires a uri", async () => {
    const res = await handlerFor("read_artifact")({});
    expect(res.isError).toBe(true);
    expect(firstText(res)).toMatch(/uri is required/i);
  });
});

describe("list_artifacts tool handler", () => {
  it("lists, threads the type filter, and formats rows", async () => {
    let seenOpts: { type?: string } | undefined;
    setArtifactResolver(
      stub<ArtifactResolver>({
        list: async (ws: string, opts: { type?: string }) => {
          expect(ws).toBe(WS);
          seenOpts = opts;
          return {
            items: [
              {
                artifactId: "art_1",
                uri: "artifact://art_1",
                type: "demo.kind",
                mimeType: "text/markdown",
                title: "Title One",
                source: "task",
                status: "ready",
                createdAt: "2026-06-16T00:00:00Z",
              },
            ],
          };
        },
      }),
    );

    const res = await handlerFor("list_artifacts")({ type: "demo.kind" });
    expect(res.isError).toBeFalsy();
    expect(seenOpts?.type).toBe("demo.kind");
    expect(firstText(res)).toMatch(/Title One/);
    expect(firstText(res)).toMatch(/artifact:\/\/art_1/);
    expect((res.structuredContent as { artifacts: unknown[] }).artifacts).toHaveLength(1);
  });

  it("handles the empty case", async () => {
    setArtifactResolver(
      stub<ArtifactResolver>({
        list: async () => ({ items: [] }),
      }),
    );
    const res = await handlerFor("list_artifacts")({});
    expect(res.isError).toBeFalsy();
    expect(firstText(res)).toMatch(/no artifacts/i);
  });
});
