/**
 * A connector's record-arguments grant (ADR-0058) comes from its operator-trusted
 * catalog entry, and a workspace narrows or revokes it on the connector's ref.
 *
 * One `Runtime`, a catalog with one entry declaring `recordArguments` and others
 * declaring it false, only in the unread snake_case spelling, or not at all, and a workspace holding a ref to each plus a ref under the
 * granted entry's name at another server's URL.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../src/runtime/runtime.ts";
import { connectorListCatalogs } from "../helpers/connector-list-catalog.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const WS = "ws_00c6a1d2e3f4b5c6";
const OTHER_WS = "ws_00d7b2e3f4a5c6d7";
/** `slugifyServerName("ai.acme/outbound")`. */
const OUTBOUND = "ai-acme-outbound";
/** `slugifyServerName("ai.acme/notes")`. */
const NOTES = "ai-acme-notes";
const OUTBOUND_URL = "https://outbound.acme.test/mcp";
const NOTES_URL = "https://notes.acme.test/mcp";
const LEDGER = "ai-acme-ledger";
const LEDGER_URL = "https://ledger.acme.test/mcp";
const SPLIT = "ai-acme-split";
const SPLIT_URL = "https://split.acme.test/mcp";

const testDir = join(tmpdir(), `nb-record-grant-${Date.now()}`);
const catalogDir = join(testDir, "catalog");

const CATALOG_YAML = `servers:
  - name: ai.acme/outbound
    title: Acme Outbound
    description: Receives records from other connectors
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: ${OUTBOUND_URL}
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
      ai.nimblebrain/host:
        hostVersion: "1.5"
        recordArguments: true
  - name: ai.acme/ledger
    title: Acme Ledger
    description: Declares the grant false
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: ${LEDGER_URL}
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
      ai.nimblebrain/host:
        hostVersion: "1.5"
        recordArguments: false
  - name: ai.acme/split
    title: Acme Split
    description: Declares the grant only in the unread snake_case spelling
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: ${SPLIT_URL}
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
      ai.nimblebrain/host:
        hostVersion: "1.5"
        record_arguments: true
  - name: ai.acme/notes
    title: Acme Notes
    description: Declares nothing
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: ${NOTES_URL}
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
`;

let runtime: Runtime;

beforeAll(async () => {
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, "acme.yaml"), CATALOG_YAML);
  runtime = await Runtime.start({
    catalogs: connectorListCatalogs(catalogDir),
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  const store = runtime.getWorkspaceStore();
  await seedWorkspace(store, WS, { name: WS });
  await store.update(WS, {
    connectors: [
      { url: OUTBOUND_URL, serverName: OUTBOUND },
      { url: NOTES_URL, serverName: NOTES },
      { url: LEDGER_URL, serverName: LEDGER },
      { url: SPLIT_URL, serverName: SPLIT },
    ],
  });
  await seedWorkspace(store, OTHER_WS, { name: OTHER_WS });
  await store.update(OTHER_WS, {
    connectors: [{ url: "https://outbound.other.test/mcp", serverName: OUTBOUND }],
  });
});

afterAll(async () => {
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

/** Writes `sources` as stored, typed `unknown` so a test can persist a malformed value. */
async function setRecordSources(sources: unknown): Promise<void> {
  const store = runtime.getWorkspaceStore();
  const ws = await store.get(WS);
  if (!ws) throw new Error("workspace missing");
  await store.update(WS, {
    connectors: ws.connectors.map((ref) => {
      if (ref.serverName !== OUTBOUND) return ref;
      const { recordSources: _prior, ...rest } = ref;
      return sources === undefined ? rest : { ...rest, recordSources: sources as string[] };
    }),
  });
}

describe("record-arguments grant", () => {
  it("grants every source to a connector whose catalog entry declares recordArguments", async () => {
    expect(await runtime.recordArgumentsGrantFor(WS, OUTBOUND)).toEqual({ sources: "all" });
  });

  it("grants nothing when recordArguments is false", async () => {
    expect(await runtime.recordArgumentsGrantFor(WS, LEDGER)).toBeNull();
  });

  it("grants nothing for record_arguments, which is not read", async () => {
    expect(await runtime.recordArgumentsGrantFor(WS, SPLIT)).toBeNull();
  });

  it("grants nothing to a connector whose entry declares nothing, or to one not installed", async () => {
    expect(await runtime.recordArgumentsGrantFor(WS, NOTES)).toBeNull();
    expect(await runtime.recordArgumentsGrantFor(WS, "ai-acme-absent")).toBeNull();
  });

  it("grants nothing to a ref that carries the entry's name at another server's URL", async () => {
    expect(await runtime.recordArgumentsGrantFor(OTHER_WS, OUTBOUND)).toBeNull();
  });

  it("narrows to the workspace's named sources, and an empty list revokes", async () => {
    await setRecordSources(["ai-nimblebrain-people"]);
    expect(await runtime.recordArgumentsGrantFor(WS, OUTBOUND)).toEqual({
      sources: new Set(["ai-nimblebrain-people"]),
    });
    await setRecordSources([]);
    expect(await runtime.recordArgumentsGrantFor(WS, OUTBOUND)).toBeNull();
    await setRecordSources(undefined);
    expect(await runtime.recordArgumentsGrantFor(WS, OUTBOUND)).toEqual({ sources: "all" });
  });

  it("grants nothing when the stored recordSources is not a list of names", async () => {
    for (const malformed of [null, "ai-nimblebrain-people", ["ai-nimblebrain-people", 7]]) {
      await setRecordSources(malformed);
      expect(await runtime.recordArgumentsGrantFor(WS, OUTBOUND)).toBeNull();
    }
    await setRecordSources(undefined);
    expect(await runtime.recordArgumentsGrantFor(WS, OUTBOUND)).toEqual({ sources: "all" });
  });
});
