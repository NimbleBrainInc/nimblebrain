/**
 * A run key that is present opens and parses, or the runtime does not start
 * (ADR-0035: a sealed value opens or refuses). Each boot here fails before it
 * returns a runtime, so nothing is left to shut down.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_KEY_CREDENTIAL } from "../../src/runtime/run-key.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { runKeyJwk } from "../helpers/run-key.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDirHolding(value: string): string {
  const dir = mkdtempSync(join(tmpdir(), "run-key-refusal-"));
  dirs.push(dir);
  const secretsDir = join(dir, "credentials", "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(secretsDir, RUN_KEY_CREDENTIAL), value, { mode: 0o600 });
  return dir;
}

function boot(workDir: string): Promise<Runtime> {
  return Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
}

test("a ring that does not parse refuses to start", async () => {
  const key = runKeyJwk("k1");
  const dir = workDirHolding(JSON.stringify({ keys: [{ ...key, x: runKeyJwk("k2").x }] }));
  await expect(boot(dir)).rejects.toThrow(/run-key.*two keys/);
});

test("a value that claims to be sealed and does not open refuses to start", async () => {
  const dir = workDirHolding("NBS1.not-a-sealed-value");
  await expect(boot(dir)).rejects.toThrow(/sealed/);
});
