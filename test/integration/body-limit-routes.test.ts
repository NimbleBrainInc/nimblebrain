import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-body-limit-test-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    files: {
      // Lowered from the default 100 MB so the tests don't need to allocate
      // huge buffers to prove the multipart cap is distinct from JSON.
      maxTotalSize: 4 * 1024 * 1024,
    },
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

describe("per-route body limits", () => {
  it("rejects >1MB JSON on /v1/tools/call with structured details", async () => {
    const oversized = "x".repeat(1_100_000);
    const res = await fetch(`${baseUrl}/v1/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: JSON.stringify({ server: "x", tool: "y", arguments: { blob: oversized } }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("payload_too_large");
    expect(body.details?.limit).toBe(1_048_576);
    expect(typeof body.details?.received).toBe("number");
    expect(body.details?.received).toBeGreaterThan(1_048_576);
    expect(body.details?.contentType).toContain("application/json");
  });

  it("rejects >1MB JSON on /v1/chat", async () => {
    const oversized = "x".repeat(1_100_000);
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: JSON.stringify({ message: oversized, workspaceId: TEST_WORKSPACE_ID }),
    });
    expect(res.status).toBe(413);
  });

  it("rejects multipart on /v1/chat/stream when over filesConfig.maxTotalSize", async () => {
    // maxTotalSize was configured to 4 MB above; a 5 MB multipart body must 413.
    const bigFile = new Blob([new Uint8Array(5 * 1024 * 1024)], {
      type: "application/octet-stream",
    });
    const form = new FormData();
    form.append("message", "test");
    form.append("workspaceId", TEST_WORKSPACE_ID);
    form.append("files", bigFile, "big.bin");
    const res = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("payload_too_large");
    expect(body.details?.limit).toBe(4 * 1024 * 1024);
    expect(body.details?.contentType).toContain("multipart/form-data");
  });

  it("allows in-budget multipart on /v1/chat/stream past the 1MB JSON cap", { timeout: 15000 }, async () => {
    // 2 MB multipart — under the 4 MB multipart budget but well over the 1 MB
    // JSON cap. Middleware must let this through so the ingest layer (which
    // enforces per-file/MIME rules) sees it.
    const file = new Blob([new Uint8Array(2 * 1024 * 1024)], { type: "text/plain" });
    const form = new FormData();
    form.append("message", "please");
    form.append("workspaceId", TEST_WORKSPACE_ID);
    form.append("files", file, "notes.txt");
    const res = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });
    expect(res.status).not.toBe(413);
  });
});
