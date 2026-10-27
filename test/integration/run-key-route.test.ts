/**
 * The run key, assembled by `Runtime.start` from the instance scope of the
 * credential store and served at its public path: a credential the runtime
 * mints verifies against what the route serves, and the route serves no
 * private material.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKeyRoutes } from "../../src/api/routes/run-keys.ts";
import type { RunKeySetResponse, WellKnownErrorBody } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { publicOrigin } from "../../src/oauth/public-origin.ts";
import {
  MODEL_GATEWAY_AUDIENCE,
  RUN_KEY_CREDENTIAL,
  RUN_KEY_SET_PATH,
} from "../../src/runtime/run-key.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { runKeyJwk, runKeyRingValue, verifyAsGateway } from "../helpers/run-key.ts";

const signing = runKeyJwk("run-new");
const outgoing = runKeyJwk("run-old");

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let testDir: string;

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), "run-key-route-"));
  // Seeded the way `secrets set nimblebrain.run_key` writes it under the
  // default (unsealed) file backend.
  const secretsDir = join(testDir, "credentials", "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(secretsDir, RUN_KEY_CREDENTIAL), runKeyRingValue(signing, outgoing), {
    mode: 0o600,
  });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
    tasks: { maxRunDurationMs: 120_000 },
  });
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

test("the route serves every ring key's public half, unauthenticated", async () => {
  const res = await fetch(`${baseUrl}${RUN_KEY_SET_PATH}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  const body = await readJson<RunKeySetResponse>(res);
  expect(body.keys).toEqual([
    { kty: "OKP", crv: "Ed25519", x: signing.x, kid: "run-new", alg: "EdDSA", use: "sig" },
    { kty: "OKP", crv: "Ed25519", x: outgoing.x, kid: "run-old", alg: "EdDSA", use: "sig" },
  ]);
});

test("and no private material", async () => {
  const text = await (await fetch(`${baseUrl}${RUN_KEY_SET_PATH}`)).text();
  expect(text).not.toContain(signing.d);
  expect(text).not.toContain(outgoing.d);
  expect(text).not.toContain('"d"');
});

test("a credential the runtime mints verifies against the served set", async () => {
  const runKey = runtime.getRunKey();
  if (!runKey) throw new Error("run key not loaded");
  const now = Date.now();
  const token = runKey.mintModelCredential({ runId: "run_1", workspaceId: "ws_acme" }, now);
  const served = await readJson<RunKeySetResponse>(await fetch(`${baseUrl}${RUN_KEY_SET_PATH}`));
  const { header, claims } = await verifyAsGateway(token, served, {
    issuer: publicOrigin(),
    audience: MODEL_GATEWAY_AUDIENCE,
  });
  expect(header.kid).toBe("run-new");
  expect(claims.sub).toBe("run_1");
  // The installation's run ceiling, plus the leeway, bounds the lifetime.
  expect(claims.exp).toBe(Math.ceil((now + 120_000 + 60_000) / 1000));
});

test("an installation with no run key answers 404", async () => {
  const res = await runKeyRoutes({ getRunKey: () => null }).request(RUN_KEY_SET_PATH);
  expect(res.status).toBe(404);
  expect((await readJson<WellKnownErrorBody>(res)).error).toBe("not_found");
});
