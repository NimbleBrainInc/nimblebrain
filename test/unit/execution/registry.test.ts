import { describe, expect, test } from "bun:test";
import type { AgentRuntimeConfig, ExecutionConfig } from "../../../src/config/execution.ts";
import {
  type AgentRuntimeDeps,
  assertPoolable,
  createAgentRuntimes,
} from "../../../src/execution/registry.ts";
import type { AgentRuntime } from "../../../src/execution/types.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";

const signed = () => "connection-jwt";
const deps = (over: Partial<AgentRuntimeDeps> = {}): AgentRuntimeDeps => ({
  resolveModel: () => createEchoModel(),
  connectionCredential: signed,
  dev: false,
  ...over,
});

function stubRuntime(id: string): AgentRuntime {
  return {
    id,
    capabilities: { spendGate: false, usage: "reported" },
    execute: () => Promise.reject(new Error("not run")),
  };
}

const GATEWAY = "http://model-gateway.tenant-a.svc/v1";

const worker = (over: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig => ({
  driver: "nimblebrain-agent",
  url: "http://agent-pool.tenant-a.svc:8080/acp",
  ...over,
});

/** An `execution` block with one worker, `pool`, behind the gateway. */
const pooled = (over: Partial<ExecutionConfig> = {}): ExecutionConfig => ({
  modelGateway: GATEWAY,
  runtimes: { pool: worker() },
  ...over,
});

describe("createAgentRuntimes", () => {
  test("selects a supplied runtime by id, and native by default", () => {
    const runtimes = createAgentRuntimes(undefined, [stubRuntime("scripted")], deps());
    expect(runtimes.select("scripted").id).toBe("scripted");
    expect(runtimes.select(undefined).id).toBe("native");
  });

  test("rejects two runtimes with the same id, or one named native", () => {
    expect(() =>
      createAgentRuntimes(undefined, [stubRuntime("scripted"), stubRuntime("scripted")], deps()),
    ).toThrow('execution.runtimes: "scripted" is named twice');
    expect(() => createAgentRuntimes(undefined, [stubRuntime("native")], deps())).toThrow(
      '"native" is named twice',
    );
    expect(() => createAgentRuntimes(pooled(), [stubRuntime("pool")], deps())).toThrow(
      '"pool" is named twice',
    );
  });

  test("builds a configured worker as an ACP runtime that takes a session credential and holds no spend gate", () => {
    const runtimes = createAgentRuntimes(pooled({ default: "pool" }), [], deps());
    expect(runtimes.select("pool")).toMatchObject({
      id: "pool",
      capabilities: { spendGate: false, modelCredential: "session", usage: "reported" },
    });
  });

  test("a default naming nothing fails the boot", () => {
    expect(() => createAgentRuntimes({ default: "missing" }, [], deps())).toThrow(
      'execution.default names "missing"',
    );
  });
});

describe("a configured worker, at boot", () => {
  test("needs the model gateway outside the dev identity provider", () => {
    expect(() => createAgentRuntimes(pooled({ modelGateway: undefined }), [], deps())).toThrow(
      /execution.runtimes needs execution.modelGateway/,
    );
  });

  test("needs the run key outside the dev identity provider", () => {
    expect(() =>
      createAgentRuntimes(
        pooled({ modelGateway: undefined }),
        [],
        deps({ connectionCredential: null }),
      ),
    ).toThrow(/needs the installation's run key to sign the connection credential/);
  });

  test("a model gateway needs the run key, which mints the turn's credential, even in dev", () => {
    expect(() =>
      createAgentRuntimes(pooled(), [], deps({ connectionCredential: null, dev: true })),
    ).toThrow(/modelGateway needs the installation's run key/);
  });

  test("in dev, a worker on the developer's machine needs neither", () => {
    const runtimes = createAgentRuntimes(
      { runtimes: { local: worker({ url: "http://127.0.0.1:8080/acp" }) } },
      [],
      deps({ connectionCredential: null, dev: true }),
    );
    expect(runtimes.select("local").id).toBe("local");
  });

  test("a gateway with no runtimes configured is not checked", () => {
    expect(() =>
      createAgentRuntimes({ modelGateway: GATEWAY }, [], deps({ connectionCredential: null })),
    ).not.toThrow();
  });

  test("its addresses are http(s) URLs", () => {
    expect(() =>
      createAgentRuntimes(
        pooled({ runtimes: { pool: worker({ url: "agent-pool:8080" }) } }),
        [],
        deps(),
      ),
    ).toThrow(/execution.runtimes.pool.url must be an http\(s\) URL/);
    expect(() =>
      createAgentRuntimes(pooled({ modelGateway: "ftp://gateway" }), [], deps()),
    ).toThrow(/execution.modelGateway must be an http\(s\) URL/);
  });
});

describe("a worker pool", () => {
  test("serves only an agent whose tools are the run's projection", () => {
    expect(() => assertPoolable("pool", { toolSurface: "projection" })).not.toThrow();
    expect(() => assertPoolable("pool", { toolSurface: "mixed" })).toThrow(
      /execution.runtimes.pool: its agent has tools of its own/,
    );
  });
});
