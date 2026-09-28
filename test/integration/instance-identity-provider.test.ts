/**
 * `instance.json` names the identity provider, `dev` included, and nothing
 * else does. A runtime with no `instance.json` has no provider, and the server
 * refuses to start on it rather than admit requests as a default user.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY, DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { makeTestWorkDir } from "../helpers/test-workdir.ts";

let runtime: Runtime | undefined;
let handle: ServerHandle | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  cleanup?.();
  handle = undefined;
  runtime = undefined;
  cleanup = undefined;
});

async function startRuntime(instance: unknown | null): Promise<Runtime> {
  const dir = makeTestWorkDir("instance-provider");
  cleanup = dir.cleanup;
  if (instance !== null) {
    writeFileSync(join(dir.workDir, "instance.json"), JSON.stringify(instance));
  }
  return Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: dir.workDir,
  });
}

describe("instance.json selects the identity provider", () => {
  it("a missing instance.json refuses server startup, naming what to write", async () => {
    runtime = await startRuntime(null);
    expect(runtime.getIdentityProvider()).toBeNull();

    const workDir = runtime.getWorkDir();
    const rt = runtime;
    expect(() => startServer({ runtime: rt, port: 0 })).toThrow(
      `No identity provider: ${join(workDir, "instance.json")} does not exist`,
    );
    expect(() => startServer({ runtime: rt, port: 0 })).toThrow('{"auth":{"adapter":"dev"}}');
  });

  it('`adapter: "dev"` authenticates every request as the dev user', async () => {
    runtime = await startRuntime({ auth: { adapter: "dev" } });
    expect(runtime.getIdentityProvider()).toBeInstanceOf(DevIdentityProvider);

    handle = startServer({ runtime, port: 0 });
    const res = await fetch(`http://localhost:${handle.port}/v1/bootstrap`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe(DEV_IDENTITY.id);
  });

  it("a malformed adapter refuses runtime startup", async () => {
    await expect(startRuntime({ auth: { adapter: "none" } })).rejects.toThrow(
      'unknown auth adapter "none"',
    );
  });
});
