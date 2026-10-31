/**
 * An app's UI resource is cached by the browser and revalidated on each use.
 *
 * The UI is one inlined HTML document of several hundred KB, and the shell
 * refetches it every time a view of the app opens. `private, no-cache` keeps a
 * copy in the browser only and makes it ask before each use; the ETag lets an
 * unchanged resource answer `304` with no body.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_IDENTITY, testAuthAdapter } from "../helpers/test-auth-adapter.ts";

const API_KEY = "app-resource-http-cache-test-key";
const testDir = join(tmpdir(), `nb-app-resource-http-cache-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let resourceUrl: string;
const auth = { Authorization: `Bearer ${API_KEY}` };

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: testAuthAdapter(API_KEY),
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  const store = runtime.getWorkspaceStore();
  const wsId = (await store.create("Acme Corp")).id;
  await store.addMember(wsId, TEST_IDENTITY.id, "admin");
  await runtime.ensureWorkspaceRegistry(wsId);
  handle = startServer({ runtime, port: 0 });
  resourceUrl = `http://localhost:${handle.port}/v1/workspaces/${wsId}/apps/conversations/resources/primary`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

describe("app UI resources use the browser's HTTP cache", () => {
  it("is private, revalidated on each use, and carries a weak ETag", async () => {
    const res = await fetch(resourceUrl, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("etag")).toMatch(/^W\/".+"$/);
  });

  it("answers an unchanged resource with 304 and no body, still revalidated", async () => {
    const first = await fetch(resourceUrl, { headers: auth });
    const tag = first.headers.get("etag");
    expect(tag).not.toBeNull();
    const again = await fetch(resourceUrl, {
      headers: { ...auth, "If-None-Match": tag as string },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("sends the whole resource when the browser's copy is out of date", async () => {
    const res = await fetch(resourceUrl, { headers: { ...auth, "If-None-Match": 'W/"stale"' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contents: { uri: string }[] };
    expect(body.contents[0]?.uri).toContain("ui://");
  });

  it("marks no refusal cacheable", async () => {
    const res = await fetch(resourceUrl);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
