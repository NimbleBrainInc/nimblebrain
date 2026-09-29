/**
 * A well-formed wrong key, through `Runtime.start`.
 *
 * The canary cannot catch it — seal-then-open round-trips under any key — so
 * this is the regression for the one check that can: every sealed secret on
 * disk is under a key the ring does not hold, and the runtime must not serve.
 *
 * Its own file because `Runtime.start` installs process-global handles.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createCredentialSealer } from "../../src/tools/credential-seal.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const KEY_ENV = "NB_TEST_WRONG_KEY_CREDENTIAL_KEY";
const KEY_A = Buffer.alloc(32, 0x5a);
const KEY_B = Buffer.alloc(32, 0x5b);

let testDir: string;
let sealedPath: string;
let sealedBytes: string;
let previousKey: string | undefined;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "secrets-wrong-key-boot-"));
  const secretsDir = join(testDir, "credentials", "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  sealedPath = join(secretsDir, "acme.key");
  sealedBytes = createCredentialSealer([KEY_A]).seal("instance", "acme.key", "sealed-under-a");
  writeFileSync(sealedPath, sealedBytes, { mode: 0o600 });
  previousKey = process.env[KEY_ENV];
});

afterAll(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
  rmSync(testDir, { recursive: true, force: true });
});

function boot(): Promise<Runtime> {
  return Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
    secrets: { backend: "file", config: { seal: { keyEnv: KEY_ENV } } },
  });
}

test("sealed under A, ring [B]: start throws naming both key ids", async () => {
  process.env[KEY_ENV] = KEY_B.toString("base64");
  const err = await boot().then(
    async (runtime) => {
      await runtime.shutdown();
      return undefined;
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  const message = (err as Error).message;
  expect(message).toContain(createCredentialSealer([KEY_A]).sealingKid);
  expect(message).toContain(createCredentialSealer([KEY_B]).sealingKid);
  expect(readFileSync(sealedPath, "utf-8")).toBe(sealedBytes);
});

test("ring [B, A]: boots and re-wraps under B", async () => {
  process.env[KEY_ENV] = `${KEY_B.toString("base64")},${KEY_A.toString("base64")}`;
  const runtime = await boot();
  try {
    const wrapped = await runtime
      .getCredentialStore()
      .get({ kind: "instance" }, "acme.key", { caller: "test", purpose: "boot assertion" });
    expect(wrapped?.reveal()).toBe("sealed-under-a");
    expect(readFileSync(sealedPath, "utf-8")).toContain(
      `.${createCredentialSealer([KEY_B]).sealingKid}.`,
    );
  } finally {
    await runtime.shutdown();
  }
});
