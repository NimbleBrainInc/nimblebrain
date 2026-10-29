import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import type { EngineEvent, ToolCall, ToolSchema } from "../../../src/engine/types.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import { createNimbleBrainAgentDriver } from "../../../src/execution/acp/drivers/nimblebrain-agent.ts";
import { createHttpConnection } from "../../../src/execution/acp/http-connection.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { publicOrigin } from "../../../src/oauth/public-origin.ts";
import { RunDeadlineExceededError } from "../../../src/runtime/errors.ts";
import { createRunKey, parseRunKeyRing, type RunKey } from "../../../src/runtime/run-key.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { PINNED_AGENT_BIN } from "../../helpers/acp/nimblebrain-agent-driver.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { type FakeAnthropic, startFakeAnthropic } from "../../helpers/fake-anthropic.ts";
import { makeIdentity } from "../../helpers/identity.ts";
import { runKeyJwk, runKeyRingValue } from "../../helpers/run-key.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../../helpers/test-workspace.ts";

// An external runtime as an installation runs one (ADR-0057): the pinned
// nimblebrain-agent served as a worker (`nimblebrain-agent serve`), which the
// runtime dials over Streamable HTTP with a connection credential signed by
// its run key. The worker verifies it against the runtime's published key set.
// The turn's tools travel on the ACP connection; its model calls go to the
// gateway (a fake Anthropic endpoint) with the turn's model credential.

const MODEL = "anthropic:claude-sonnet-4-6";
const RUN_KEY_ENV = "NB_TEST_REMOTE_AGENT_RUN_KEY";

const LOOKUP_ORDER: ToolSchema = {
  name: "lookup_order",
  description: "Look up an order's status by id",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
};

let gateway: FakeAnthropic;
let keySet: ReturnType<typeof Bun.serve>;
let worker: ReturnType<typeof Bun.spawn>;
let workerUrl: string;
let runKey: RunKey;
const ring = runKeyRingValue(runKeyJwk("run-1"));

/** A port nothing listens on, for the worker to take. */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port;
}

/** Start the worker and wait for the address it serves at. */
async function startWorker(
  jwksUrl: string,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; url: string }> {
  const proc = Bun.spawn(
    [process.execPath, "--no-env-file", realpathSync(PINNED_AGENT_BIN), "serve"],
    {
      env: {
        PATH: "/usr/bin:/bin",
        NB_AGENT_HOST: "127.0.0.1",
        NB_AGENT_PORT: String(freePort()),
        NB_AGENT_AUTH_JWKS_URL: jwksUrl,
        NB_AGENT_AUTH_ISSUER: publicOrigin(),
        NB_AGENT_MODEL: MODEL,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  let seen = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`worker exited before serving: ${seen}`);
    seen += new TextDecoder().decode(value);
    // The log line is coloured: break it at each escape so the URL ends where the colour starts.
    const plain = seen.split(String.fromCharCode(27)).join(" ");
    const match = plain.match(/serving ACP at (http:\/\/\S+)/);
    if (match?.[1]) {
      reader.releaseLock();
      return { proc, url: match[1] };
    }
  }
}

beforeAll(async () => {
  gateway = startFakeAnthropic({ toolInput: '{"orderId":"8812"}' });
  runKey = createRunKey({ ring: parseRunKeyRing(ring), issuer: publicOrigin(), maxRunMs: 600_000 });
  keySet = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(runKey.keySet()),
  });
  const started = await startWorker(`http://127.0.0.1:${keySet.port}/.well-known/run-keys.json`);
  worker = started.proc;
  workerUrl = started.url;
});

afterAll(async () => {
  worker?.kill("SIGTERM");
  await worker?.exited;
  await keySet?.stop(true);
  await gateway?.close();
});

function resolvedRun(runId: string, modelCredential?: string): ResolvedRun {
  return {
    runId,
    conversationId: null,
    system: "You are an order assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Where is order 8812?" }] }],
    tools: [LOOKUP_ORDER],
    config: { model: MODEL, maxIterations: 5, maxInputTokens: 100_000, maxOutputTokens: 1_000 },
    ...(modelCredential ? { modelCredential } : {}),
  };
}

function lookupRouter(calls: ToolCall[]) {
  return new StaticToolRouter([LOOKUP_ORDER], (call) => {
    calls.push(call);
    return { content: [{ type: "text", text: "shipped Oct 20" }], isError: false };
  });
}

describe("an external runtime over the network", () => {
  test("runs a turn on the worker, tools on the connection, models through the gateway", async () => {
    const credential = runKey.mintModelCredential({ runId: "run_remote", workspaceId: "ws_test" });
    const runtime = createAcpRuntime(
      "pool",
      createNimbleBrainAgentDriver({ modelGateway: gateway.rootUrl }),
      createHttpConnection({
        url: workerUrl,
        credential: () => runKey.mintConnectionCredential(),
      }),
    );
    const calls: ToolCall[] = [];
    const events: EngineEvent[] = [];
    const before = gateway.authorizations.length;

    const result = await runtime.execute(resolvedRun("run_remote", credential), {
      tools: lookupRouter(calls),
      events: { emit: (e) => events.push(e) },
      billSummary: () => {},
    });

    expect(result.stopReason).toBe("complete");
    expect(result.output.trim()).toBe("The tool says: shipped Oct 20");
    expect(calls.map((c) => c.input)).toEqual([{ orderId: "8812" }]);
    // Every model call carried the turn's credential, not a provider key.
    const authorizations = gateway.authorizations.slice(before);
    expect(authorizations.length).toBe(2);
    expect(new Set(authorizations)).toEqual(new Set([`Bearer ${credential}`]));
    // At the session model's provider on the gateway, with no provider key.
    expect(new Set(gateway.paths.slice(before))).toEqual(new Set(["/anthropic/v1/messages"]));
    expect(new Set(gateway.apiKeys.slice(before))).toEqual(new Set([null]));
    expect(events.some((e) => e.type === "execution.bound")).toBe(true);
  });

  test("a runtime whose credential the worker cannot verify is refused, as a run error", async () => {
    const stranger = createRunKey({
      ring: parseRunKeyRing(runKeyRingValue(runKeyJwk("run-1"))),
      issuer: publicOrigin(),
      maxRunMs: 600_000,
    });
    const runtime = createAcpRuntime(
      "pool",
      createNimbleBrainAgentDriver(),
      createHttpConnection({
        url: workerUrl,
        credential: () => stranger.mintConnectionCredential(),
      }),
    );
    const events: EngineEvent[] = [];
    await expect(
      runtime.execute(resolvedRun("run_stranger"), {
        tools: lookupRouter([]),
        events: { emit: (e) => events.push(e) },
        billSummary: () => {},
      }),
    ).rejects.toThrow();
    expect(events.filter((e) => e.type === "run.error")).toHaveLength(1);
  });
});

describe("the door, with the worker configured in execution", () => {
  const workDir = join(tmpdir(), `nb-remote-agent-${Date.now()}`);
  let runtime: Runtime;

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true });
    process.env[RUN_KEY_ENV] = ring;
    runtime = await Runtime.start({
      identityProvider: devProvider,
      models: { default: MODEL },
      logging: { disabled: true },
      workDir,
      secrets: { runKeyEnv: RUN_KEY_ENV },
      execution: {
        default: "pool",
        modelGateway: gateway.rootUrl,
        runtimes: { pool: { driver: "nimblebrain-agent", url: workerUrl } },
      },
    });
    await provisionTestWorkspace(runtime);
  });

  afterAll(async () => {
    await runtime?.shutdown();
    delete process.env[RUN_KEY_ENV];
    rmSync(workDir, { recursive: true, force: true });
  });

  test("mints the turn's model credential, naming the run and the workspace", async () => {
    const before = gateway.authorizations.length;
    const result = await runtime.chat({
      message: "hello",
      workspaceId: TEST_WORKSPACE_ID,
      identity: makeIdentity({ id: "usr_dev", email: "dev@example.com", orgRole: "admin" }),
    });
    expect(result.response.length).toBeGreaterThan(0);

    const [authorization] = gateway.authorizations.slice(before);
    const token = authorization?.replace(/^Bearer /, "") ?? "";
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    expect(claims).toMatchObject({
      iss: publicOrigin(),
      aud: "model-gateway",
      workspace: TEST_WORKSPACE_ID,
    });
    expect(typeof claims.sub).toBe("string");
    // A chat turn has no limit of its own, so the door holds it to the
    // installation's longest run (600s by default) and mints to that.
    expect(claims.exp - claims.iat).toBeGreaterThanOrEqual(660);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(661);
  });

  test("mints a task run's credential to the run's own duration cap", async () => {
    const before = gateway.authorizations.length;
    await runtime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "Where is order 8812?",
      trigger: "manual",
      maxRunDurationMs: 30_000,
    });

    const [authorization] = gateway.authorizations.slice(before);
    const token = authorization?.replace(/^Bearer /, "") ?? "";
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    expect(claims.exp - claims.iat).toBeGreaterThanOrEqual(90);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(91);
  });
});

describe("the door, holding a credentialed chat turn to the installation's longest run", () => {
  const workDir = join(tmpdir(), `nb-remote-agent-deadline-${Date.now()}`);
  let stalled: ReturnType<typeof Bun.serve>;
  let runtime: Runtime;

  beforeAll(async () => {
    // A gateway that takes each model call and never answers, so the turn
    // stalls on the worker until something ends it.
    stalled = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new Promise<Response>((resolve) =>
          req.signal.addEventListener("abort", () => resolve(new Response(null)), { once: true }),
        ),
    });
    mkdirSync(workDir, { recursive: true });
    process.env[RUN_KEY_ENV] = ring;
    runtime = await Runtime.start({
      identityProvider: devProvider,
      models: { default: MODEL },
      logging: { disabled: true },
      workDir,
      secrets: { runKeyEnv: RUN_KEY_ENV },
      execution: {
        default: "pool",
        modelGateway: `http://127.0.0.1:${stalled.port}`,
        runtimes: { pool: { driver: "nimblebrain-agent", url: workerUrl } },
      },
    });
    await provisionTestWorkspace(runtime);
  });

  afterAll(async () => {
    await runtime?.shutdown();
    delete process.env[RUN_KEY_ENV];
    rmSync(workDir, { recursive: true, force: true });
    await stalled?.stop(true);
  });

  test("ends a stalled turn at the limit with RunDeadlineExceededError", async () => {
    // The configured ceiling's floor is 10s; a shorter one keeps the test fast.
    const tasks = runtime.getTasksConfig();
    const ceiling = spyOn(runtime, "getTasksConfig").mockReturnValue({
      ...tasks,
      maxRunDurationMs: 1_000,
    });
    try {
      const started = Date.now();
      const turn = runtime.chat({
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
        identity: makeIdentity({ id: "usr_dev", email: "dev@example.com", orgRole: "admin" }),
      });
      await expect(turn).rejects.toBeInstanceOf(RunDeadlineExceededError);
      await expect(turn).rejects.toThrow("reached its 1s limit (tasks.maxRunDurationMs)");
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    } finally {
      ceiling.mockRestore();
    }
  });
});

describe("the native engine, its provider reached through the gateway", () => {
  const workDir = join(tmpdir(), `nb-native-gateway-${Date.now()}`);
  let runtime: Runtime;

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true });
    process.env[RUN_KEY_ENV] = ring;
    runtime = await Runtime.start({
      identityProvider: devProvider,
      models: { default: MODEL },
      providers: { anthropic: { gateway: true } },
      logging: { disabled: true },
      workDir,
      secrets: { runKeyEnv: RUN_KEY_ENV },
      execution: { modelGateway: gateway.rootUrl },
    });
    await provisionTestWorkspace(runtime);
  });

  afterAll(async () => {
    await runtime?.shutdown();
    delete process.env[RUN_KEY_ENV];
    rmSync(workDir, { recursive: true, force: true });
  });

  /** The claims of each credential the gateway saw since `before`. */
  const claimsSince = (before: number) =>
    gateway.authorizations.slice(before).map((a) => {
      const token = a?.replace(/^Bearer /, "") ?? "";
      return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    });

  test("calls the provider at its path on the gateway, with a credential per call and no key", async () => {
    const turn = async () => {
      const before = gateway.authorizations.length;
      const result = await runtime.chat({
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
        identity: DEV_IDENTITY,
      });
      expect(result.response.length).toBeGreaterThan(0);
      expect(new Set(gateway.paths.slice(before))).toEqual(new Set(["/anthropic/v1/messages"]));
      expect(new Set(gateway.apiKeys.slice(before))).toEqual(new Set([null]));
      return claimsSince(before);
    };
    const firstTurn = await turn();
    expect(firstTurn[0]).toMatchObject({
      iss: publicOrigin(),
      aud: "model-gateway",
      workspace: TEST_WORKSPACE_ID,
    });
    // The subject is the turn's run, so the gateway budgets per turn. (A
    // conversation's title is written after its first turn, inside it, so the
    // second turn's window may also hold a call charged to the first.)
    const firstSubjects = new Set(firstTurn.map((c) => c.sub));
    const secondTurn = await turn();
    expect(secondTurn.some((c) => !firstSubjects.has(c.sub))).toBe(true);
  });
});
