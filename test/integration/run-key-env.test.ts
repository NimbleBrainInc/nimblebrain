/**
 * `secrets.runKeyEnv` names the variable the run key is read from at boot: the
 * named variable is the only source, a stored copy is ignored, and a named
 * variable that holds nothing refuses the start. A model gateway with no run key
 * refuses the start too.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_KEY_CREDENTIAL } from "../../src/runtime/run-key.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { runKeyJwk, runKeyRingValue } from "../helpers/run-key.ts";

const ENV_NAME = "NB_TEST_RUN_KEY";
const dirs: string[] = [];
const runtimes: Runtime[] = [];

afterEach(async () => {
  delete process.env[ENV_NAME];
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(stored?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "run-key-env-"));
  dirs.push(dir);
  if (stored !== undefined) {
    const secretsDir = join(dir, "credentials", "secrets");
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(secretsDir, RUN_KEY_CREDENTIAL), stored, { mode: 0o600 });
  }
  return dir;
}

async function boot(dir: string, runKeyEnv?: string): Promise<Runtime> {
  const runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: dir,
    ...(runKeyEnv ? { secrets: { runKeyEnv } } : {}),
  });
  runtimes.push(runtime);
  return runtime;
}

test("a named variable is the run key, and a stored copy is ignored", async () => {
  const fromEnv = runKeyJwk("run-env");
  const fromStore = runKeyJwk("run-store");
  process.env[ENV_NAME] = runKeyRingValue(fromEnv);
  const runtime = await boot(workDir(runKeyRingValue(fromStore)), ENV_NAME);
  expect(
    runtime
      .getRunKey()
      ?.keySet()
      .keys.map((key) => key.kid),
  ).toEqual(["run-env"]);
});

test("a named variable that holds nothing refuses the start", async () => {
  await expect(boot(workDir(runKeyRingValue(runKeyJwk("run-store"))), ENV_NAME)).rejects.toThrow(
    new RegExp(`runKeyEnv names ${ENV_NAME}, which holds no run key`),
  );
});

test("a named variable that does not parse refuses the start, naming no key material", async () => {
  process.env[ENV_NAME] = '{"keys": []}';
  await expect(boot(workDir(), ENV_NAME)).rejects.toThrow(/names no key/);
});

test("with no variable named, the stored run key is used as before", async () => {
  process.env[ENV_NAME] = runKeyRingValue(runKeyJwk("run-env"));
  const runtime = await boot(workDir(runKeyRingValue(runKeyJwk("run-store"))));
  expect(
    runtime
      .getRunKey()
      ?.keySet()
      .keys.map((key) => key.kid),
  ).toEqual(["run-store"]);
});

test("a model gateway without the run key refuses the start, with no external runtime", async () => {
  const start = Runtime.start({
    identityProvider: devProvider,
    logging: { disabled: true },
    workDir: workDir(),
    execution: { modelGateway: "http://gateway.test" },
  });
  await expect(start).rejects.toThrow(/execution\.modelGateway needs the installation's run key/);
});
