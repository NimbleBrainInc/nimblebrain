/**
 * The scheduled demo owns its workdir: an inherited `NB_WORK_DIR` reaches
 * neither the seed nor the runtime. A `.env` value cannot either, because
 * `loadDotenvIntoProcess` skips keys already set (covered in dev-env.test.ts).
 * Its ports are the shell's `NB_API_PORT` / `NB_WEB_PORT` when set.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { demoEnv, demoPorts } from "../../../scripts/dev-scheduled-demo.ts";
import { loadConfig } from "../../../src/cli/config.ts";

const ENV_DIR = join(import.meta.dir, "../../../.environments/scheduled-demo");
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

describe("demoPorts", () => {
  test("defaults to 27257 / 27256", () => {
    expect(demoPorts({})).toEqual({ api: "27257", web: "27256" });
  });

  test("an empty value falls back to the default", () => {
    expect(demoPorts({ NB_API_PORT: "", NB_WEB_PORT: "" })).toEqual({ api: "27257", web: "27256" });
  });

  test("honors NB_API_PORT / NB_WEB_PORT, and demoEnv passes them to the runtime", () => {
    const base = { NB_API_PORT: "31001", NB_WEB_PORT: "31000" };
    expect(demoPorts(base)).toEqual({ api: "31001", web: "31000" });
    const env = demoEnv(base);
    expect(env.NB_API_PORT).toBe("31001");
    expect(env.NB_WEB_PORT).toBe("31000");
  });
});
