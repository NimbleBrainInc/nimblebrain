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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const KEY_ENV = "NB_TEST_BOOT_CREDENTIAL_KEY";
const SET_LONG_AGO = new Date("2024-03-01T12:00:00.000Z");
const INSTANCE = { kind: "instance" } as const;
const READ = { caller: "test", purpose: "boot assertion" };

let runtime: Runtime;
let testDir: string;
let previousKey: string | undefined;

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), "secrets-sealed-boot-"));

  // A plaintext instance secret already on the volume, seeded the way an
  // operator does. Turning sealing on must not strand it — the boot sweep
  // re-wraps it — and it must not lose the one thing `list` reports about it.
  const secretsDir = join(testDir, "credentials", "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const legacyPath = join(secretsDir, "legacy.key");
  writeFileSync(legacyPath, "seeded-before-sealing\n", { mode: 0o600 });
  utimesSync(legacyPath, SET_LONG_AGO, SET_LONG_AGO);

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

test("the plaintext secret seeded before sealing was re-sealed at boot", () => {
  // `Runtime.start` awaits the reconcile before anything reads a secret, so by
  // the time a test can look there is no plaintext left.
  const raw = readFileSync(join(testDir, "credentials", "secrets", "legacy.key"), "utf-8");
  expect(raw.startsWith("NBS1.")).toBe(true);
  expect(raw).not.toContain("seeded-before-sealing");
});

test("and still reads back as the value it was", async () => {
  const wrapped = await runtime.getCredentialStore().get(INSTANCE, "legacy.key", READ);
  expect(wrapped?.reveal()).toBe("seeded-before-sealing");
});

test("the sweep did not restamp it as just-changed", async () => {
  // `list` reports mtime as `updatedAt`. Without preservation, every secret on
  // the volume would read as set at the moment sealing was switched on.
  expect(statSync(join(testDir, "credentials", "secrets", "legacy.key")).mtime.toISOString()).toBe(
    SET_LONG_AGO.toISOString(),
  );
  const [entry] = (await runtime.getCredentialStore().list(INSTANCE)).filter(
    (e) => e.key === "legacy.key",
  );
  expect(entry?.updatedAt).toBe(SET_LONG_AGO.toISOString());
});

test("plaintext dropped in after that clean sweep is refused", async () => {
  // Strict mode, through the real boot path: a file nobody wrote through the
  // store is either an operator editing by hand or an injection.
  writeFileSync(join(testDir, "credentials", "secrets", "injected.key"), "attacker-chosen", {
    mode: 0o600,
  });
  const wrapped = await runtime.getCredentialStore().get(INSTANCE, "injected.key", READ);
  expect(wrapped).not.toBeNull(); // the probe still answers
  expect(() => wrapped?.reveal()).toThrow(/plaintext/);
});
