import { describe, expect, test } from "bun:test";
import type { AgentRuntimeConfig } from "../../../src/config/execution.ts";
import { type AgentRuntimeDeps, createAgentRuntimes } from "../../../src/execution/registry.ts";
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
    capabilities: { spendGate: false },
    execute: () => Promise.reject(new Error("not run")),
  };
}

const worker = (over: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig => ({
  type: "acp",
  driver: "nimblebrain-agent",
  url: "http://agent-pool.tenant.svc:8080/acp",
  modelEndpoint: "http://model-gateway.tenant.svc/v1",
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
    expect(() =>
      createAgentRuntimes({ runtimes: { pool: worker() } }, [stubRuntime("pool")], deps()),
    ).toThrow('"pool" is named twice');
  });

  test("builds a configured worker as an ACP runtime with no spend gate", () => {
    const runtimes = createAgentRuntimes(
      { default: "pool", runtimes: { pool: worker() } },
      [],
      deps(),
    );
    expect(runtimes.select("pool")).toMatchObject({
      id: "pool",
      capabilities: { spendGate: false },
    });
  });

  test("a default naming nothing fails the boot", () => {
    expect(() => createAgentRuntimes({ default: "missing" }, [], deps())).toThrow(
      'execution.default names "missing"',
    );
  });
});

describe("a configured worker, at boot", () => {
  test("needs a model gateway outside the dev identity provider", () => {
    expect(() =>
      createAgentRuntimes({ runtimes: { pool: worker({ modelEndpoint: undefined }) } }, [], deps()),
    ).toThrow(/execution.runtimes.pool needs a modelEndpoint/);
  });

  test("needs the run key outside the dev identity provider", () => {
    expect(() =>
      createAgentRuntimes(
        { runtimes: { pool: worker({ modelEndpoint: undefined }) } },
        [],
        deps({ connectionCredential: null }),
      ),
    ).toThrow(/needs the installation's run key to sign its connection credential/);
  });

  test("a model gateway needs the run key, which mints the turn's credential, even in dev", () => {
    expect(() =>
      createAgentRuntimes(
        { runtimes: { pool: worker() } },
        [],
        deps({ connectionCredential: null, dev: true }),
      ),
    ).toThrow(/modelEndpoint needs the installation's run key/);
  });

  test("in dev, a worker on the developer's machine needs neither", () => {
    const runtimes = createAgentRuntimes(
      {
        runtimes: { local: worker({ url: "http://127.0.0.1:8080/acp", modelEndpoint: undefined }) },
      },
      [],
      deps({ connectionCredential: null, dev: true }),
    );
    expect(runtimes.select("local").id).toBe("local");
  });

  test("its addresses are http(s) URLs", () => {
    expect(() =>
      createAgentRuntimes({ runtimes: { pool: worker({ url: "agent-pool:8080" }) } }, [], deps()),
    ).toThrow(/url must be an http\(s\) URL/);
    expect(() =>
      createAgentRuntimes(
        { runtimes: { pool: worker({ modelEndpoint: "ftp://gateway" }) } },
        [],
        deps(),
      ),
    ).toThrow(/modelEndpoint must be an http\(s\) URL/);
  });
});
