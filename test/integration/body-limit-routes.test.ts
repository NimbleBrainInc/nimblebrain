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

const MAX_TOTAL_SIZE = 10 * 1024 * 1024;

function multipartBody(bytes: number) {
  const form = new FormData();
  form.append("message", "please");
  form.append("workspaceId", TEST_WORKSPACE_ID);
  form.append("files", new Blob([new Uint8Array(bytes)], { type: "text/plain" }), "notes.txt");
  return form;
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    files: {
      // Lowered from the default 100 MB so the tests don't need to allocate
      // huge buffers to prove the multipart cap is distinct from JSON, but
      // deliberately kept ABOVE the middleware's 8 MB drain overrun so a
      // refusal here drains on the same terms a default deployment's does.
      // At 4 MB it did not: the refusal sat under a flat ceiling that the
      // 100 MB default never reached, so the suite agreed with itself while
      // every real multipart refusal went out undrained.
      maxTotalSize: MAX_TOTAL_SIZE,
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
    // maxTotalSize was configured to 10 MB above; a 12 MB multipart body must 413.
    const res = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: multipartBody(12 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("payload_too_large");
    expect(body.details?.limit).toBe(MAX_TOTAL_SIZE);
    expect(body.details?.contentType).toContain("multipart/form-data");
  });

  it("allows in-budget multipart on /v1/chat/stream past the 1MB JSON cap", async () => {
    // 2 MB multipart — under the 10 MB multipart budget but well over the 1 MB
    // JSON cap. Middleware must let this through so the ingest layer (which
    // enforces per-file/MIME rules) sees it.
    const res = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: multipartBody(2 * 1024 * 1024),
    });
    expect(res.status).not.toBe(413);
  });

  // The failure this guards is not the refusal — that part always worked — but
  // what the refusal does to the connection underneath it. An undrained body
  // leaves a pooled keep-alive connection desynchronized, and the request that
  // pays for it is the NEXT one, which on a shared pool belongs to somebody
  // else. Measured at 26 hung follow-ups in 30 pairs before the drain reached
  // multipart, 0 after, so a single pair would usually catch a regression and
  // five make it near-certain.
  it("leaves the connection usable after a multipart refusal", async () => {
    for (let i = 0; i < 5; i++) {
      const refused = await fetch(`${baseUrl}/v1/chat/stream`, {
        method: "POST",
        headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
        body: multipartBody(12 * 1024 * 1024),
      });
      expect(refused.status).toBe(413);
      await refused.arrayBuffer();

      // Same origin, so this rides the pooled connection the refusal just used.
      // A regression presents as a hang here, not as a wrong status.
      const followUp = await fetch(`${baseUrl}/v1/chat/stream`, {
        method: "POST",
        headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
        body: multipartBody(1024),
        signal: AbortSignal.timeout(5_000),
      });
      expect(followUp.status).not.toBe(413);
      await followUp.body?.cancel();
    }
  });
});
