import { describe, expect, it } from "bun:test";
import { agentRuntimeFromEnv } from "../../../src/config/agent-runtime.ts";
import { createAgentRuntimes } from "../../../src/execution/registry.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";

const env = {
  NB_AGENT_RUNTIME: "claude-code",
  NB_AGENT_RUNTIME_URL: "http://host.docker.internal:27290/acp",
};

describe("agentRuntimeFromEnv", () => {
  it("changes nothing when the environment names no runtime, or native", () => {
    expect(agentRuntimeFromEnv(undefined, {})).toEqual({});
    expect(
      agentRuntimeFromEnv(undefined, { NB_AGENT_RUNTIME: "", NB_AGENT_RUNTIME_URL: "" }),
    ).toEqual({});
    expect(agentRuntimeFromEnv(undefined, { ...env, NB_AGENT_RUNTIME: "native" })).toEqual({});
  });

  it("adds the named runtime and makes it the default", () => {
    expect(agentRuntimeFromEnv(undefined, env)).toEqual({
      execution: {
        default: "claude-code",
        runtimes: {
          "claude-code": { driver: "claude-code", url: "http://host.docker.internal:27290/acp" },
        },
      },
    });
    expect(
      agentRuntimeFromEnv(undefined, {
        NB_AGENT_RUNTIME: "codex",
        NB_AGENT_RUNTIME_URL: "http://host.docker.internal:27291/acp",
      }).execution?.default,
    ).toBe("codex");
  });

  it("leaves an execution block the file sets alone, and says why", () => {
    const file = { default: "native" };
    const result = agentRuntimeFromEnv(file, env);
    expect(result.execution).toBeUndefined();
    expect(result.ignored).toContain("nimblebrain.json sets execution");
  });

  it("fails the boot on a half-set or unknown runtime", () => {
    expect(() => agentRuntimeFromEnv(undefined, { NB_AGENT_RUNTIME: "claude-code" })).toThrow(
      /NB_AGENT_RUNTIME_URL is not/,
    );
    expect(() =>
      agentRuntimeFromEnv(undefined, { NB_AGENT_RUNTIME_URL: env.NB_AGENT_RUNTIME_URL }),
    ).toThrow(/NB_AGENT_RUNTIME is not/);
    expect(() =>
      agentRuntimeFromEnv(undefined, { ...env, NB_AGENT_RUNTIME: "nimblebrain-agent" }),
    ).toThrow(/must be claude-code or codex/);
  });
});

describe("a runtime the environment names, at boot", () => {
  const execution = agentRuntimeFromEnv(undefined, env).execution;
  const deps = (dev: boolean, runKey: boolean) => ({
    resolveModel: () => createEchoModel(),
    connectionCredential: runKey ? () => "connection-jwt" : null,
    dev,
  });

  it("is refused outside the dev identity provider, with or without a run key", () => {
    expect(() => createAgentRuntimes(execution, [], deps(false, true))).toThrow();
    expect(() => createAgentRuntimes(execution, [], deps(false, false))).toThrow();
  });

  it("boots under the dev identity provider as the default runtime", () => {
    const runtimes = createAgentRuntimes(execution, [], deps(true, false));
    expect(runtimes.select(execution?.default).capabilities.ownModel).toBe(
      "claude-code-subscription",
    );
  });
});
