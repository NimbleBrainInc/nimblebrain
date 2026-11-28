/**
 * The operator's per-file limit (`files.maxFileSize`) is the files plugin's
 * too: the binding passes it to the server it starts
 * in its environment (`NB_FILES_MAX_FILE_BYTES`, `filesServerEnv`), so a limit
 * raised past the plugin's own 25 MiB default takes a file that large, and
 * `begin_upload` refuses at the host's size, not at another.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UploadResourceResponse } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const MiB = 1024 * 1024;
const LIMIT = 40 * MiB;
const testDir = join(tmpdir(), `nimblebrain-files-limit-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let base: string;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
    files: { maxFileSize: LIMIT },
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  base = `http://localhost:${handle.port}`;
}, 60_000);

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  rmSync(testDir, { recursive: true, force: true });
}, 30_000);

describe("a per-file limit raised past the plugin's default", () => {
  it("takes a 30 MiB upload and serves it back whole", async () => {
    const size = 30 * MiB;
    const form = new FormData();
    form.append("file", new File([new Uint8Array(size)], "big.bin"));
    const res = await fetch(`${base}/v1/workspaces/${TEST_WORKSPACE_ID}/resources`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await readJson<UploadResourceResponse>(res);
    expect(body.errors).toBeUndefined();
    const entry = body.files[0];
    expect(entry?.size).toBe(size);

    const served = await fetch(`${base}/v1/workspaces/${TEST_WORKSPACE_ID}/files/${entry?.id}`);
    expect(served.status).toBe(200);
    expect((await served.arrayBuffer()).byteLength).toBe(size);
  }, 60_000);

  it("is the size begin_upload refuses past", async () => {
    const files = runtime.getFiles();
    if (!files) throw new Error("files are off");
    const scope = { workspaceId: TEST_WORKSPACE_ID, ownerId: DEV_IDENTITY.id };
    const args = {
      filename: "x.bin",
      mimeType: "application/octet-stream",
      source: "app" as const,
    };
    await expect(files.beginUpload(scope, { ...args, size: LIMIT })).resolves.toMatchObject({
      method: "PUT",
    });
    await expect(files.beginUpload(scope, { ...args, size: LIMIT + 1 })).rejects.toMatchObject({
      code: "too_large",
    });
  });
});
