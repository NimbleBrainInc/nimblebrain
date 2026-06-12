import { hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  ArtifactsClient,
  isTerminalTaskStatus,
  NimbleTasksClient,
} from "../../src/dataplane/dataplane-client.ts";
import { ServiceTokenCache, type TenantIdentity } from "../../src/oauth/tenant-key-mint.ts";

const MASTER = randomBytes(32);
const TID = "hq";
const TENANT_KEY = Buffer.from(hkdfSync("sha256", MASTER, Buffer.from(TID, "utf8"), Buffer.from("mcp-authorizer/v1"), 32));
const IDENTITY: TenantIdentity = { tid: TID, tenantKey: TENANT_KEY };
const ISSUER = "https://authz.test";

/** Minimal authorizer that mints a token encoding the requested audience, so the
 *  service fetch can assert the right aud-scoped bearer arrived. */
function fakeAuthorizer() {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    const wire = body.get("tenant_assertion") ?? "";
    const payload = JSON.parse(Buffer.from(wire.split(".")[1] as string, "base64url").toString("utf8")) as {
      audience: string;
    };
    return Response.json({ access_token: `tok-${payload.audience}`, token_type: "Bearer", expires_in: 300 });
  };
  return { fetchImpl };
}

function cache() {
  return new ServiceTokenCache({ identity: IDENTITY, fetchImpl: fakeAuthorizer().fetchImpl, now: () => 1000 });
}

describe("NimbleTasksClient", () => {
  const opts = (svc: typeof fetch) => ({ issuer: ISSUER, workspace: "ws_smoke", cache: cache(), baseFetch: svc });

  it("creates a task with aud=mcp-fleet and returns the task ref", async () => {
    let seen: { url: string; auth: string | null; body: unknown } | undefined;
    const svc: typeof fetch = async (input, init) => {
      seen = {
        url: String(input),
        auth: new Headers(init?.headers).get("Authorization"),
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({ task_id: "task_abc", status: "working" });
    };
    const client = new NimbleTasksClient("https://nt.test", opts(svc));

    const ref = await client.createTask({
      taskType: "deep-research",
      input: { query: "x" },
      idempotencyKey: "idem-1",
      mcpServer: "web",
      toolName: "deep_research",
    });

    expect(ref).toEqual({ taskId: "task_abc", status: "working", statusMessage: undefined });
    expect(seen?.url).toBe("https://nt.test/v1/tasks");
    expect(seen?.auth).toBe("Bearer tok-mcp-fleet"); // nimbletasks accepts the fleet audience
    expect(seen?.body).toMatchObject({ task_type: "deep-research", idempotency_key: "idem-1", input: { query: "x" } });
  });

  it("polls status and fetches the terminal result", async () => {
    const svc: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/result")) return Response.json({ available: true, result: { report: "done" } });
      return Response.json({ task_id: "task_abc", status: "completed" });
    };
    const client = new NimbleTasksClient("https://nt.test", opts(svc));

    const status = await client.getTask("task_abc");
    expect(isTerminalTaskStatus(status.status)).toBe(true);
    const result = await client.getResult("task_abc");
    expect(result).toEqual({ available: true, result: { report: "done" } });
  });

  it("surfaces a non-2xx as DataPlaneError with the status", async () => {
    const svc: typeof fetch = async () => new Response("nope", { status: 403 });
    const client = new NimbleTasksClient("https://nt.test", opts(svc));
    await expect(client.createTask({ taskType: "x", idempotencyKey: "i" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("ArtifactsClient", () => {
  it("writes an artifact with aud=artifacts and base64-encodes the body", async () => {
    let seen: { auth: string | null; body: { body_b64: string; type: string } } | undefined;
    const svc: typeof fetch = async (_input, init) => {
      seen = {
        auth: new Headers(init?.headers).get("Authorization"),
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({ artifact_id: "art_1", uri: "artifact://art_1", mime_type: "text/markdown", size_bytes: 6 });
    };
    const client = new ArtifactsClient("https://art.test", {
      issuer: ISSUER,
      workspace: "ws_smoke",
      cache: cache(),
      baseFetch: svc,
    });

    const ref = await client.writeArtifact({
      type: "report",
      mimeType: "text/markdown",
      body: "report",
      title: "Deep research",
      idempotencyKey: "idem-art-1",
    });

    expect(ref).toMatchObject({ artifactId: "art_1", uri: "artifact://art_1" });
    expect(seen?.auth).toBe("Bearer tok-artifacts");
    expect(Buffer.from(seen?.body.body_b64 ?? "", "base64").toString("utf8")).toBe("report");
    expect(seen?.body.type).toBe("report");
  });
});
