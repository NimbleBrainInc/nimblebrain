/**
 * Sealing, assembled by `Runtime.start` — the whole path a tenant's config
 * takes to put ciphertext on disk: the block names an environment variable, the
 * backend reads the ring from it, the canary runs, and the store that comes out
 * the other side writes `NBS1.…`.
 *
 * Its own file rather than a case in `secrets-door-boot.test.ts`, because
 * `Runtime.start` installs process-global handles — the credential store and
 * the connectors config among them. A second boot inside that suite replaces
 * what its other assertions are reading.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const KEY_ENV = "NB_TEST_BOOT_CREDENTIAL_KEY";
const INSTANCE = { kind: "instance" } as const;
const READ = { caller: "test", purpose: "boot assertion" };

let runtime: Runtime;
let testDir: string;
let previousKey: string | undefined;

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), "secrets-sealed-boot-"));

  // A plaintext instance secret already on the volume, seeded the way an
  // operator does. Turning sealing on must not strand it: the boot re-seal
  // sweep is what re-wraps it, and until then it still reads.
  const secretsDir = join(testDir, "credentials", "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(secretsDir, "legacy.key"), "seeded-before-sealing\n", { mode: 0o600 });

  previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = Buffer.alloc(32, 0x3c).toString("base64");

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
    secrets: { backend: "file", config: { seal: { keyEnv: KEY_ENV } } },
  });
});

afterAll(async () => {
  await runtime?.stop?.();
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
  rmSync(testDir, { recursive: true, force: true });
});

test("a put lands as ciphertext on disk", async () => {
  await runtime.getCredentialStore().put(INSTANCE, "acme.gateway_key", "sealed-at-boot");
  const raw = readFileSync(join(testDir, "credentials", "secrets", "acme.gateway_key"), "utf-8");
  expect(raw.startsWith("NBS1.")).toBe(true);
  expect(raw).not.toContain("sealed-at-boot");
});

test("and reads back through the same door", async () => {
  const wrapped = await runtime.getCredentialStore().get(INSTANCE, "acme.gateway_key", READ);
  expect(wrapped?.reveal()).toBe("sealed-at-boot");
});

test("a plaintext secret seeded before sealing still reads", async () => {
  const wrapped = await runtime.getCredentialStore().get(INSTANCE, "legacy.key", READ);
  expect(wrapped?.reveal()).toBe("seeded-before-sealing");
});

test("and reading it does not rewrite it — one write mechanism, the sweep's", () => {
  expect(readFileSync(join(testDir, "credentials", "secrets", "legacy.key"), "utf-8")).toBe(
    "seeded-before-sealing\n",
  );
});
