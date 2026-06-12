import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { createLocalOutputStore, type OutputScope } from "../../src/files/output-store.ts";
import { createFileStore, type FileStore } from "../../src/files/store.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createOutputsSource } from "../../src/tools/outputs-source.ts";
import { createSystemTools } from "../../src/tools/system-tools.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";

const WS = "ws_alpha";
const OTHER_WS = "ws_beta";

describe("outputs resolvable source (read_resource peek)", () => {
  let dir: string;
  let store: FileStore;
  let outputsSource: McpSource;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "outputs-source-"));
    store = createFileStore(join(dir, "files"));
  });
  afterEach(async () => {
    await outputsSource?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function outputStore() {
    return createLocalOutputStore({ resolveStore: (_s: OutputScope) => store });
  }

  /** Build a registry holding the outputs source, plus the nb system source so
   *  `nb__read_resource` runs the real resolution loop over the registry. */
  async function makeRegistryWith(
    getWorkspaceId: () => string | null,
  ): Promise<{ registry: ToolRegistry; nb: McpSource }> {
    const registry = new ToolRegistry();
    outputsSource = createOutputsSource({ getWorkspaceId, store: outputStore() }, new NoopEventSink());
    await outputsSource.start();
    registry.addSource(outputsSource);
    const nb = await createSystemTools(() => registry);
    registry.addSource(nb);
    return { registry, nb };
  }

  it("resolves a stored output via read_resource (peek)", async () => {
    const ref = await outputStore().put(
      { workspace: WS },
      { type: "report", mime: "text/markdown", body: "# Title\nbody text" },
    );

    const { nb } = await makeRegistryWith(() => WS);
    const res = await nb.execute("read_resource", { uri: ref.uri });

    expect(res.isError).toBe(false);
    expect(extractText(res.content)).toContain("body text");
  });

  it("truncates a >12K output with the existing note (motivates get_output)", async () => {
    const big = "z".repeat(20_000) + "TAIL";
    const ref = await outputStore().put(
      { workspace: WS },
      { type: "report", mime: "text/plain", body: big },
    );

    const { nb } = await makeRegistryWith(() => WS);
    const res = await nb.execute("read_resource", { uri: ref.uri });

    const text = extractText(res.content);
    // read_resource applies its existing 12K cap with a truncation note — the
    // full body lives behind nb__get_output.
    expect(text.length).toBeLessThan(big.length);
    expect(text).toContain("truncated");
    expect(text).not.toContain("TAIL");
  });

  it("a foreign-workspace ref resolves to not-found (no leak)", async () => {
    // Written under OTHER_WS, read from WS.
    const ref = await outputStore().put(
      { workspace: OTHER_WS },
      { type: "report", mime: "text/plain", body: "secret body" },
    );

    const { nb } = await makeRegistryWith(() => WS);
    const res = await nb.execute("read_resource", { uri: ref.uri });

    expect(res.isError).toBe(true);
    const text = extractText(res.content);
    expect(text).not.toContain("secret body");
    expect(text).toContain("not found");
  });

  it("an unknown files:// ref resolves to not-found (no crash)", async () => {
    const { nb } = await makeRegistryWith(() => WS);
    const res = await nb.execute("read_resource", { uri: "files://fl_missing" });

    expect(res.isError).toBe(true);
    expect(extractText(res.content)).toContain("not found");
  });
});
