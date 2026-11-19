/**
 * The plugins demo owns its workdir: an inherited `NB_WORK_DIR` reaches
 * neither the seed nor the runtime. A `.env` value cannot either, because
 * `loadDotenvIntoProcess` skips keys already set (covered in dev-env.test.ts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { demoEnv } from "../../../scripts/dev-plugins-demo.ts";
import { loadConfig } from "../../../src/cli/config.ts";

const ENV_DIR = join(import.meta.dir, "../../../.environments/plugins-demo");
const previous = process.env.NB_WORK_DIR;

afterEach(() => {
  if (previous === undefined) delete process.env.NB_WORK_DIR;
  else process.env.NB_WORK_DIR = previous;
});

describe("demoEnv", () => {
  test("replaces an inherited NB_WORK_DIR with the demo directory", () => {
    const env = demoEnv({ NB_WORK_DIR: "/tmp/someone-elses-workdir" });
    expect(env.NB_WORK_DIR).toBe(ENV_DIR);
  });

  test("the demo config then resolves to the demo directory", () => {
    process.env.NB_WORK_DIR = "/tmp/someone-elses-workdir";
    process.env.NB_WORK_DIR = demoEnv(process.env).NB_WORK_DIR;
    const { workDir } = loadConfig({ config: join(ENV_DIR, "nimblebrain.json") });
    expect(workDir).toBe(ENV_DIR);
  });
});
