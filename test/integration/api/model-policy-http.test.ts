import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../../src/api/server.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-model-policy-http-${Date.now()}`);

const ALLOWED = "anthropic:claude-sonnet-4-6";
const REFUSED = "anthropic:claude-opus-4-6";
// Dev mode (no identity provider) resolves every request to this owner.
const DEV_OWNER = "usr_default";

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    // Carries the allowlist. It also displaces the echo adapter, so a turn that
    // clears the gate then fails against a placeholder key — which is fine
    // here: every assertion is about the response the gate produces.
    providers: { anthropic: { apiKey: "test-key", models: ["claude-sonnet-4-6"] } },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
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

const post = (path: string, body: Record<string, unknown>) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
    body: JSON.stringify(body),
  });

// Both chat doors reach the same gate, so both must report it the same way.
// They did not: `/v1/chat/start` kept a private copy of the error mapping that
// omitted this class and answered 500 — on the route the web client uses.
describe.each([["/v1/chat"], ["/v1/chat/start"]])("%s refuses a disallowed model", (route) => {
  it("answers 400 model_not_allowed, naming the model and the configured providers", async () => {
    const res = await post(route, { message: "hi", model: REFUSED });
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      error: string;
      details?: { model?: string; configuredProviders?: string[] };
    };
    expect(body.error).toBe("model_not_allowed");
    expect(body.details?.model).toBe(REFUSED);
    expect(body.details?.configuredProviders).toContain("anthropic");
  });

  it("does not answer 400 for a model on the allowlist", async () => {
    const res = await post(route, { message: "hi", model: ALLOWED });
    expect(res.status).not.toBe(400);
  });
});

// The gate skips a resume, because the pin wins and the request's model is
// discarded. Both doors build their create options lazily to get that, and
// both need holding: `/v1/chat` and `/v1/chat/start` reach it through
// different methods, so a test on one leaves the other free to regress.
describe.each([["/v1/chat"], ["/v1/chat/start"]])(
  "%s resumes a pinned conversation without gating the request model",
  (route) => {
    it("does not answer model_not_allowed", async () => {
      const store = runtime.workspaceConversationStore(TEST_WORKSPACE_ID, DEV_OWNER);
      const { id } = await store.create({
        ownerId: DEV_OWNER,
        workspaceId: TEST_WORKSPACE_ID,
        model: ALLOWED,
      });

      const res = await post(route, { message: "again", conversationId: id, model: REFUSED });
      const body = (await res.json().catch(() => ({}))) as { error?: string };

      expect(body.error).not.toBe("model_not_allowed");
      // Not a vacuous pass: the resume has to actually reach the turn, so an
      // ownership or lookup refusal would be a different bug wearing the same
      // green.
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(404);
    });
  },
);
