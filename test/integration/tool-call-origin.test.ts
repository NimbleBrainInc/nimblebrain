/**
 * The `/v1` tool-call doors refuse an untrusted browser origin, as `/mcp/<wsId>`
 * does (ADR-0065).
 *
 * A page whose hostname rebinds to the runtime's address is same-origin to the
 * browser, so CORS does not stop it, and the `dev` adapter authenticates every
 * request. Its `Origin` still names the attacker's hostname, and that is what
 * these routes check, before authentication. A request with no `Origin` (the
 * CLI, any server caller) passes, and so does the web shell's own origin.
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

const WEB_ORIGIN = "http://localhost:27246";
const REBOUND = "rebound.attacker.example";
const testDir = join(tmpdir(), `nb-tool-call-origin-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let port: number;
let wsId: string;
let savedWebUrl: string | undefined;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  savedWebUrl = process.env.NB_WEB_URL;
  process.env.NB_WEB_URL = WEB_ORIGIN;
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  wsId = (await runtime.getWorkspaceStore().create("Acme Corp")).id;
  await runtime.getWorkspaceStore().addMember(wsId, DEV_IDENTITY.id, "admin");
  await runtime.ensureWorkspaceRegistry(wsId);
  handle = startServer({ runtime, port: 0 });
  port = handle.port;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (savedWebUrl === undefined) delete process.env.NB_WEB_URL;
  else process.env.NB_WEB_URL = savedWebUrl;
  rmSync(testDir, { recursive: true, force: true });
});

function call(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      server: "nb",
      tool: "manage_connectors",
      arguments: { action: "list_personal_connectors" },
    }),
  });
}

const doors = () => [`/v1/workspaces/${wsId}/tools/call`, "/v1/tools/call"];

describe("the /v1 tool-call doors and the request's Origin", () => {
  it("refuse a DNS-rebound page (foreign Origin and Host) with 403 before authentication", async () => {
    for (const path of doors()) {
      const res = await call(path, {
        Origin: `http://${REBOUND}:${port}`,
        Host: `${REBOUND}:${port}`,
      });
      expect(res.status).toBe(403);
      // Under `dev` the app-wide host allowlist answers before the door's own
      // Origin check (test/integration/local-host-allowlist.test.ts).
      expect((await readJson<ApiErrorBody>(res)).error).toBe("untrusted_host");
    }
  });

  it("refuse a foreign Origin on the runtime's own host", async () => {
    for (const path of doors()) {
      const res = await call(path, { Origin: "https://attacker.example" });
      expect(res.status).toBe(403);
      expect((await readJson<ApiErrorBody>(res)).error).toBe("untrusted_origin");
    }
  });

  it("admit a request with no Origin (the CLI)", async () => {
    for (const path of doors()) {
      expect((await call(path)).status).toBe(200);
    }
  });

  it("admit the web shell's origin", async () => {
    for (const path of doors()) {
      expect((await call(path, { Origin: WEB_ORIGIN })).status).toBe(200);
    }
  });

  it("admit the runtime opened at its own loopback address", async () => {
    for (const path of doors()) {
      expect((await call(path, { Origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    }
  });
});
