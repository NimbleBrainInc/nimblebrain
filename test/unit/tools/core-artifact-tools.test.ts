import { afterEach, describe, expect, it } from "bun:test";
import type { ArtifactResolver } from "../../../src/host-resources/artifacts/artifact-resolver.ts";
import {
  ArtifactNotFoundError,
  setArtifactResolver,
} from "../../../src/host-resources/artifacts/index.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import { createCoreToolDefs } from "../../../src/tools/core-source.ts";

// Behavioral tests for the read_artifact / list_artifacts core tool HANDLERS
// (the client + persistence are covered in artifact-resolver.test.ts and
// event-sourced-store.test.ts). We drive the real handlers with a minimal mock
// runtime (only requireWorkspaceId is exercised) and a fake resolver injected
// through the setArtifactResolver test seam — so the uri normalization, the
// contents→text extraction, the not-found mapping, and the list formatting are
// all under test, not just the data-plane plumbing.

const WS = "ws_test";
const runtime = { requireWorkspaceId: () => WS } as unknown as Runtime;

function handlerFor(name: string): (input: Record<string, unknown>) => Promise<{
  content: Array<{ text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  const tool = createCoreToolDefs(runtime).find((d) => d.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler as never;
}

function firstText(res: { content: Array<{ text?: string }> }): string {
  return res.content[0]?.text ?? "";
}

afterEach(() => setArtifactResolver(undefined));

describe("read_artifact tool handler", () => {
  it("reads a text artifact, normalizing a bare id to artifact://", async () => {
    let seen: { uri: string; ws: string } | undefined;
    setArtifactResolver({
      read: async (uri: string, ws: string) => {
        seen = { uri, ws };
        return { contents: [{ uri, mimeType: "text/markdown", text: "# Report\nbody" }] };
      },
    } as unknown as ArtifactResolver);

    const res = await handlerFor("read_artifact")({ uri: "art_1" });
    expect(res.isError).toBeFalsy();
    expect(firstText(res)).toBe("# Report\nbody");
    // bare id was normalized to an artifact:// URI, and the verified ws passed through
    expect(seen).toEqual({ uri: "artifact://art_1", ws: WS });
  });

  it("passes an explicit artifact:// uri through unchanged", async () => {
    let seenUri = "";
    setArtifactResolver({
      read: async (uri: string) => {
        seenUri = uri;
        return { contents: [{ uri, mimeType: "text/markdown", text: "x" }] };
      },
    } as unknown as ArtifactResolver);
    await handlerFor("read_artifact")({ uri: "artifact://art_9" });
    expect(seenUri).toBe("artifact://art_9");
  });

  it("renders a binary placeholder for non-text contents", async () => {
    setArtifactResolver({
      read: async (uri: string) => ({
        contents: [{ uri, mimeType: "application/pdf", blob: "AAAA" }],
      }),
    } as unknown as ArtifactResolver);
    const res = await handlerFor("read_artifact")({ uri: "art_pdf" });
    expect(firstText(res)).toMatch(/binary artifact/);
    expect(firstText(res)).toMatch(/application\/pdf/);
  });

  it("maps ArtifactNotFoundError to a clean not-found result", async () => {
    setArtifactResolver({
      read: async () => {
        throw new ArtifactNotFoundError("art_x");
      },
    } as unknown as ArtifactResolver);
    const res = await handlerFor("read_artifact")({ uri: "artifact://art_x" });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toMatch(/not found in this workspace/i);
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
    setArtifactResolver({
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
    } as unknown as ArtifactResolver);

    const res = await handlerFor("list_artifacts")({ type: "demo.kind" });
    expect(res.isError).toBeFalsy();
    expect(seenOpts?.type).toBe("demo.kind");
    expect(firstText(res)).toMatch(/Title One/);
    expect(firstText(res)).toMatch(/artifact:\/\/art_1/);
    expect((res.structuredContent as { artifacts: unknown[] }).artifacts).toHaveLength(1);
  });

  it("handles the empty case", async () => {
    setArtifactResolver({
      list: async () => ({ items: [] }),
    } as unknown as ArtifactResolver);
    const res = await handlerFor("list_artifacts")({});
    expect(res.isError).toBeFalsy();
    expect(firstText(res)).toMatch(/no artifacts/i);
  });
});
