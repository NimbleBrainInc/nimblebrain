import { describe, expect, test } from "bun:test";
import { parse } from "../src/args.ts";
import { nimblebrainModelName, numCtxOf, takesLocalModel } from "../src/local-model.ts";
import { run } from "../src/main.ts";
import { LOCAL_COMPOSE, type MachineOptions, machine, REPO_COMPOSE } from "./fake.ts";

const HOME = "/home/dana/.nimblebrain-local";
const ENV = `${HOME}/.env`;
const env = { NIMBLEBRAIN_TAG: "v0.73.0" };
const compose = { status: 200, body: LOCAL_COMPOSE };
const GEMMA = { capabilities: ["completion", "tools"] };

/** A run as a person at a terminal sees it: no `--json`, which never asks. */
async function atTerminal(argv: string[], opts: MachineOptions) {
  const m = machine({ env, compose, interactive: true, ...opts });
  const { stdout, code } = await run(argv, m.deps);
  return { stdout, code, m };
}

async function json(argv: string[], opts: MachineOptions = {}) {
  const m = machine({ env, compose, ...opts });
  const { stdout, code } = await run([...argv, "--json"], m.deps);
  return { body: JSON.parse(stdout), code, m };
}

describe("the release's Compose file", () => {
  test("a release takes a local model when its Compose file passes NB_LOCAL_MODEL_URL", () => {
    expect(takesLocalModel(LOCAL_COMPOSE)).toBe(true);
    expect(takesLocalModel("services:\n  platform:\n    environment:\n      - X=1\n")).toBe(false);
  });
});

describe("init on a local model", () => {
  test("--local-model prepares the model on Ollama and points the runtime at it", async () => {
    const { body, code, m } = await json(["--yes", "--local-model", "gemma4:e4b"], {
      ollama: { models: { "gemma4:e4b": GEMMA } },
    });

    expect(code).toBe(0);
    expect(body.local_model).toBe("nimblebrain-gemma4-e4b");
    const envText = m.files.get(ENV)?.text ?? "";
    expect(envText).toContain("NB_LOCAL_MODEL_URL=http://host.docker.internal:11434/v1");
    expect(envText).toContain("NB_LOCAL_MODEL=nimblebrain-gemma4-e4b");
    expect(envText).toContain("NB_LOCAL_MODEL_CONTEXT=32768");
    expect(m.files.get(ENV)?.mode).toBe(0o600);
    // The copy carries a fixed window, so Ollama never picks a smaller one.
    expect(numCtxOf(m.ollamaModels["nimblebrain-gemma4-e4b"]?.parameters)).toBe(32_768);
  });

  test("a person at the terminal chooses local, and is asked before a download", async () => {
    const { code, m } = await atTerminal([], {
      answers: ["", "local", "", "none"],
      ollama: { library: { "gemma4:e4b": GEMMA } },
    });

    expect(code).toBe(0);
    expect(m.asked.some((q) => q.startsWith("Model (hosted, local)"))).toBe(true);
    expect(m.asked.some((q) => q.startsWith("Download gemma4:e4b"))).toBe(true);
    expect(m.asked.some((q) => q.includes("API_KEY"))).toBe(false);
    expect(m.ollamaModels["gemma4:e4b"]).toBeDefined();
  });

  test("a person who answers hosted is asked for a key, as before", async () => {
    const { m } = await atTerminal([], {
      answers: ["", "", "", "", "none"],
      ollama: { models: { "gemma4:e4b": GEMMA } },
    });
    expect(m.asked.some((q) => q.startsWith("Model provider"))).toBe(true);
    expect(m.files.get(ENV)?.text ?? "").not.toContain("NB_LOCAL_MODEL=");
  });

  test("Ollama not answering is LOCAL_MODEL_UNREACHABLE", async () => {
    const { body } = await json(["--yes", "--local-model", "gemma4:e4b"]);
    expect(body.error).toBe("LOCAL_MODEL_UNREACHABLE");
  });

  test("a model without tool calling is LOCAL_MODEL_NO_TOOLS", async () => {
    const { body } = await json(["--yes", "--local-model", "gemma3:4b"], {
      ollama: { models: { "gemma3:4b": { capabilities: ["completion", "vision"] } } },
    });
    expect(body.error).toBe("LOCAL_MODEL_NO_TOOLS");
  });

  test("a declined download is LOCAL_MODEL_MISSING, and nothing is pulled", async () => {
    const { stdout, m } = await atTerminal(["--local-model", "gemma4:e4b"], {
      answers: ["", "n"],
      ollama: { library: { "gemma4:e4b": GEMMA } },
    });
    expect(stdout).toContain("Ollama has no model");
    expect(m.posts.some((p) => p.url.endsWith("/api/pull"))).toBe(false);
  });

  test("a release whose runtime takes no local model is RUNTIME_UNSUPPORTED", async () => {
    const older = REPO_COMPOSE.replace(/^\s+- NB_LOCAL_MODEL[A-Z_]*=.*\n/gm, "");
    const { body } = await json(["--yes", "--local-model", "gemma4:e4b"], {
      compose: { status: 200, body: older },
      ollama: { models: { "gemma4:e4b": GEMMA } },
    });
    expect(body.error).toBe("RUNTIME_UNSUPPORTED");
  });
});

describe("local-model on an install", () => {
  async function installed(opts: MachineOptions) {
    const m = machine({ env, compose, ...opts });
    await run(["--yes", "--json"], m.deps);
    return m;
  }

  test("switches the install to a local model and starts it again", async () => {
    const m = await installed({ ollama: { models: { "qwen3:8b": GEMMA } } });
    const ups = () => m.calls.filter((c) => c.includes("docker compose up")).length;
    const before = ups();

    const { stdout } = await run(["local-model", "qwen3:8b", "--json"], m.deps);
    const body = JSON.parse(stdout);

    expect(body.local_model).toBe("nimblebrain-qwen3-8b");
    expect(ups()).toBe(before + 1);
    const status = JSON.parse((await run(["status", "--json"], m.deps)).stdout);
    expect(status.local_model).toBe("nimblebrain-qwen3-8b");
  });

  test("doctor checks Ollama, the model, its tools and its window", async () => {
    const m = await installed({ ollama: { models: { "gemma4:e4b": GEMMA } } });
    await run(["local-model", "--json"], m.deps);

    const body = JSON.parse((await run(["doctor", "--json"], m.deps)).stdout);
    expect(body.ok).toBe(true);
    const local = body.checks.filter((c: { check: string }) =>
      ["ollama", "model", "tools", "context"].includes(c.check),
    );
    expect(local.map((c: { ok: boolean }) => c.ok)).toEqual([true, true, true, true]);
  });

  test("doctor fails a model whose window is Ollama's default", async () => {
    const m = await installed({ ollama: { models: { "gemma4:e4b": GEMMA } } });
    await run(["local-model", "--json"], m.deps);
    m.ollamaModels["nimblebrain-gemma4-e4b"] = GEMMA;

    const body = JSON.parse((await run(["doctor", "--json"], m.deps)).stdout);
    expect(body.error).toBe("LOCAL_CONTEXT_SMALL");
    expect(body.checks.some((c: { check: string }) => c.check === "docker")).toBe(true);
  });
});

describe("arguments", () => {
  test("local-model takes a model; init takes --local-model", () => {
    const cmd = parse(["local-model", "gemma4:e4b"]);
    expect(cmd.kind === "run" && cmd.command === "local-model" && cmd.arg).toBe("gemma4:e4b");
    const init = parse(["--local-model", "qwen3:8b"]);
    expect(init.kind === "run" && init.flags.localModel).toBe("qwen3:8b");
  });

  test("a model name becomes a valid Ollama name for the copy", () => {
    expect(nimblebrainModelName("gemma4:e4b")).toBe("nimblebrain-gemma4-e4b");
    expect(nimblebrainModelName("hf.co/org/model:Q4_K_M")).toBe(
      "nimblebrain-hf.co-org-model-Q4_K_M",
    );
  });
});
