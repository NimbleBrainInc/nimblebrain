/**
 * An app's UI resource is served compressed.
 *
 * The UI is one inlined HTML document, often several hundred KB, and the shell
 * shows nothing until it arrives. Uncompressed, the transfer is most of the wait
 * on a slow link. The streamed routes stay uncompressed; only this one is
 * encoded.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_IDENTITY, testAuthAdapter } from "../helpers/test-auth-adapter.ts";

const API_KEY = "app-resource-compression-test-key";
const testDir = join(tmpdir(), `nb-app-resource-compression-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let wsId: string;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: testAuthAdapter(API_KEY),
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  const store = runtime.getWorkspaceStore();
  wsId = (await store.create("Acme Corp")).id;
  await store.addMember(wsId, TEST_IDENTITY.id, "admin");
  await runtime.ensureWorkspaceRegistry(wsId);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

describe("app UI resources are served compressed", () => {
  it("gzips the resource for a client that accepts it, and the body decodes to the envelope", async () => {
    const res = await fetch(
      `${baseUrl}/v1/workspaces/${wsId}/apps/conversations/resources/primary`,
      {
        headers: { Authorization: `Bearer ${API_KEY}`, "Accept-Encoding": "gzip" },
        // Bun's fetch decodes by default; keep the wire bytes to measure them.
        decompress: false,
      } as RequestInit,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const wire = new Uint8Array(await res.arrayBuffer());
    const decoded = gunzipSync(wire);
    expect(wire.byteLength).toBeLessThan(decoded.byteLength);
    const body = JSON.parse(decoded.toString("utf-8")) as { contents: { uri: string }[] };
    expect(body.contents[0]?.uri).toContain("ui://");
  });

  it("sends it unencoded to a client that asks for no encoding", async () => {
    const res = await fetch(
      `${baseUrl}/v1/workspaces/${wsId}/apps/conversations/resources/primary`,
      {
        headers: { Authorization: `Bearer ${API_KEY}`, "Accept-Encoding": "identity" },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});
