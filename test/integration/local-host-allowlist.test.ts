/**
 * Without sign-in (the `dev` adapter), the server answers only requests
 * addressed to a loopback or configured host, on every route.
 *
 * A page served under another hostname that resolves to this machine is
 * same-origin to the browser, and its GETs carry no `Origin`, so the route's
 * own checks see nothing unusual; its `Host` names that other hostname. A
 * provider that checks a credential is unaffected.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiErrorBody } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { TEST_IDENTITY, testAuthAdapter } from "../helpers/test-auth-adapter.ts";

const OTHER_HOST = "other-site.example";
/** A LAN name an operator lists in `ALLOWED_ORIGINS`. */
const LAN_ORIGIN = "http://nimblebrain.lan:27246";

interface Served {
  runtime: Runtime;
  handle: ServerHandle;
  wsId: string;
  dir: string;
}

async function serve(
  name: string,
  identityProvider: Parameters<typeof Runtime.start>[0]["identityProvider"],
  member: string,
): Promise<Served> {
  const dir = join(tmpdir(), `nb-host-allowlist-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const runtime = await Runtime.start({
    identityProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: dir,
  });
  const wsId = (await runtime.getWorkspaceStore().create("Acme Corp")).id;
  await runtime.getWorkspaceStore().addMember(wsId, member, "admin");
  await runtime.ensureWorkspaceRegistry(wsId);
  return { runtime, handle: startServer({ runtime, port: 0 }), wsId, dir };
}

async function close(s: Served): Promise<void> {
  s.handle.stop(true);
  await s.runtime.shutdown();
  rmSync(s.dir, { recursive: true, force: true });
}

function get(s: Served, path: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${s.handle.port}${path}`, { headers });
}

function startChat(s: Served, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${s.handle.port}/v1/workspaces/${s.wsId}/chat/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ message: "hello" }),
  });
}

describe("without sign-in, requests must address a loopback or configured host", () => {
  let dev: Served;
  let savedAllowed: string | undefined;

  beforeAll(async () => {
    savedAllowed = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = LAN_ORIGIN;
    dev = await serve("dev", devProvider, DEV_IDENTITY.id);
  });

  afterAll(async () => {
    await close(dev);
    if (savedAllowed === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = savedAllowed;
  });

  it("refuses a GET addressed to another hostname, with no Origin", async () => {
    const res = await get(dev, "/v1/bootstrap", { Host: `${OTHER_HOST}:${dev.handle.port}` });
    expect(res.status).toBe(403);
    expect((await readJson<ApiErrorBody>(res)).error).toBe("untrusted_host");
  });

  it("refuses a same-origin POST addressed to another hostname", async () => {
    const host = `${OTHER_HOST}:${dev.handle.port}`;
    const res = await startChat(dev, {
      Host: host,
      Origin: `http://${host}`,
      "Sec-Fetch-Site": "same-origin",
    });
    expect(res.status).toBe(403);
    expect((await readJson<ApiErrorBody>(res)).error).toBe("untrusted_host");
  });

  it("answers loopback names and addresses", async () => {
    for (const name of ["localhost", "127.0.0.1", "[::1]"]) {
      const res = await get(dev, "/v1/bootstrap", { Host: `${name}:${dev.handle.port}` });
      expect(res.status).toBe(200);
    }
    expect((await startChat(dev, { Host: `localhost:${dev.handle.port}` })).status).toBe(200);
  });

  it("answers a host named in ALLOWED_ORIGINS", async () => {
    const res = await get(dev, "/v1/bootstrap", { Host: new URL(LAN_ORIGIN).host });
    expect(res.status).toBe(200);
  });
});

describe("a provider that checks a credential", () => {
  const API_KEY = "host-allowlist-test-key";
  let signedIn: Served;

  beforeAll(async () => {
    signedIn = await serve("auth", testAuthAdapter(API_KEY), TEST_IDENTITY.id);
  });

  afterAll(async () => {
    await close(signedIn);
  });

  it("answers any host", async () => {
    const res = await get(signedIn, "/v1/bootstrap", {
      Host: `${OTHER_HOST}:${signedIn.handle.port}`,
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(res.status).toBe(200);
  });
});
