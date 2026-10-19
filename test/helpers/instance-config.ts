import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceConfig } from "../../src/identity/instance.ts";

/** Write `config` as the instance's `instance.json`, as an operator would. */
export async function writeInstanceConfig(workDir: string, config: InstanceConfig): Promise<void> {
  await writeFile(join(workDir, "instance.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
