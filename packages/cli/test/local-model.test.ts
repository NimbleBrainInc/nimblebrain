import { describe, expect, test } from "bun:test";
import { parse } from "../src/args.ts";
import type { Deps } from "../src/deps.ts";
import { nimblebrainModelName, numCtxOf, takesLocalModel } from "../src/local-model.ts";
import { run } from "../src/main.ts";
import { ERRORS, FIX_VARIANTS } from "../src/result.ts";
import {
  fail,
  LOCAL_COMPOSE,
  type MachineOptions,
  machine,
  OLLAMA_STARTS,
  ok,
  REPO_COMPOSE,
} from "./fake.ts";

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

  test("telemetry names a local model's provider as ollama, never the model", async () => {
    const { m } = await json(["--yes", "--telemetry", "on", "--local-model", "gemma4:e4b"], {
      env: { ...env, NIMBLEBRAIN_TELEMETRY_KEY: "phc_test" },
      ollama: { models: { "gemma4:e4b": GEMMA } },
    });
    const batch = m.posts
      .filter((p) => p.url.includes("posthog.com"))
      .flatMap((p) => (p.body as { batch: Array<{ event: string; properties: object }> }).batch);
    const done = batch.find((e) => e.event === "cli.init_completed");
    expect(done?.properties).toMatchObject({ provider: "ollama" });
    expect(JSON.stringify(batch)).not.toContain("gemma");
  });

  test("starts without the shell's local-model settings, so .env is the one source", async () => {
    const { code, m } = await json(["--yes", "--local-model", "gemma4:e4b"], {
      env: {
        ...env,
        NB_LOCAL_MODEL_URL: "http://localhost:9999/v1",
        NB_LOCAL_MODEL: "stale-model",
        NB_LOCAL_MODEL_CONTEXT: "4096",
      },
      ollama: { models: { "gemma4:e4b": GEMMA } },
    });
    expect(code).toBe(0);
    expect(m.composeEnvs.length).toBeGreaterThan(0);
    for (const e of m.composeEnvs) {
      expect(e.NB_LOCAL_MODEL_URL).toBeUndefined();
      expect(e.NB_LOCAL_MODEL).toBeUndefined();
      expect(e.NB_LOCAL_MODEL_CONTEXT).toBeUndefined();
    }
  });

  test("a person at the terminal chooses local, and is asked before a download", async () => {
    const { code, m } = await atTerminal([], {
      answers: ["", "local", "", "none"],
      ollama: { library: { "gemma4:e4b": GEMMA } },
    });

    expect(code).toBe(0);
    expect(m.asked.some((q) => q.startsWith("Choose 1-2, or api, local [1]"))).toBe(true);
    expect(m.asked.some((q) => q.startsWith("Download gemma4:e4b"))).toBe(true);
    expect(m.asked.some((q) => q.includes("API_KEY"))).toBe(false);
    expect(m.ollamaModels["gemma4:e4b"]).toBeDefined();
  });

  test("choosing local names the model, and the command that picks another", async () => {
    const { code, m } = await atTerminal([], {
      answers: ["", "local", "", "none"],
      ollama: { models: { "gemma4:e4b": GEMMA } },
    });

    expect(code).toBe(0);
    expect(m.said).toContain("Using gemma4:e4b. Another model: npx nimblebrain use local <model>");
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

const FIX = FIX_VARIANTS.LOCAL_MODEL_UNREACHABLE;
const APP = { "/Applications/Ollama.app/Contents/Info.plist": "<plist/>" };
const BREW = { "brew list --versions ollama": ok("ollama 0.32.5") };
const UNIT = { "/etc/systemd/system/ollama.service": "[Unit]" };
const started = (m: { calls: string[] }) =>
  m.calls.filter((c) => OLLAMA_STARTS.some((s) => c.endsWith(`$ ${s}`)));

describe("starting Ollama when it is installed but down", () => {
  test("the macOS app is opened in the background, and the answer says so", async () => {
    const { body, code, m } = await json(["--yes", "--local-model", "gemma4:e4b"], {
      platform: "darwin",
      files: APP,
      ollama: { down: "until-started", models: { "gemma4:e4b": GEMMA } },
    });
    expect(code).toBe(0);
    expect(body.ollama_started).toBe("open -g -a Ollama");
    expect(started(m)).toEqual(["$ open -g -a Ollama"]);
    expect(body.local_model).toBe("nimblebrain-gemma4-e4b");
  });

  test("a person is asked once, and Homebrew's service is named with its login start", async () => {
    const { stdout, m } = await atTerminal(["--local-model", "gemma4:e4b"], {
      platform: "darwin",
      exec: BREW,
      answers: ["", "n"],
      ollama: { down: "until-started", models: { "gemma4:e4b": GEMMA } },
    });
    const asked = m.asked.filter((q) => q.startsWith("Ollama isn't running"));
    expect(asked).toEqual([
      "Ollama isn't running. Start it with `brew services start ollama`? It then also starts at login. [Y/n] ",
    ]);
    expect(started(m)).toEqual([]);
    // init rebuilds the error with its telemetry field; the machine's fix survives that.
    expect(stdout).toContain(`fix: ${FIX.brew}`);
  });

  test("a systemd unit that will not start without sudo names the sudo command", async () => {
    const { body, m } = await json(["--yes", "--local-model", "gemma4:e4b"], {
      files: UNIT,
      exec: {
        "systemctl start --no-ask-password ollama": fail("Interactive authentication required."),
      },
      ollama: { down: "until-started" },
    });
    expect(body.error).toBe("LOCAL_MODEL_UNREACHABLE");
    expect(body.fix).toBe(FIX.systemd);
    expect(body.message).toContain("Interactive authentication required.");
    expect(m.calls.some((c) => c.includes("sudo"))).toBe(false);
  });

  test("Ollama that never answers after a start times out with that machine's fix", async () => {
    const { body } = await json(["--yes", "--local-model", "gemma4:e4b"], {
      platform: "darwin",
      files: APP,
      ollama: { down: "stays" },
    });
    expect(body.error).toBe("LOCAL_MODEL_UNREACHABLE");
    expect(body.fix).toBe(FIX.app);
    expect(body.ollama_started).toBe("open -g -a Ollama");
  });

  test("a later failure still says what was started", async () => {
    const { body } = await json(["--yes", "--local-model", "gemma3:4b"], {
      files: UNIT,
      ollama: { down: "until-started", models: { "gemma3:4b": { capabilities: ["completion"] } } },
    });
    expect(body.error).toBe("LOCAL_MODEL_NO_TOOLS");
    expect(body.ollama_started).toBe("systemctl start --no-ask-password ollama");
  });

  test("a bare ollama binary is never started; the fix says to run ollama serve", async () => {
    const { body, m } = await json(["--yes", "--local-model", "gemma4:e4b"], {
      programs: ["ollama"],
    });
    expect(body.fix).toBe(FIX.serve);
    expect(started(m)).toEqual([]);
    expect(m.asked).toEqual([]);
  });

  test("not installed, with Homebrew: the fix is brew install, and nothing is installed", async () => {
    const { body, m } = await json(["--yes", "--local-model", "gemma4:e4b"], {
      exec: { "brew list --versions ollama": fail("", 1) },
    });
    expect(body.fix).toBe(FIX.brew_install);
    expect(m.calls.some((c) => c.includes("brew install"))).toBe(false);
  });

  test("not installed, without Homebrew: the fix is the download page", async () => {
    const { body } = await json(["--yes", "--local-model", "gemma4:e4b"]);
    expect(body.fix).toBe(ERRORS.LOCAL_MODEL_UNREACHABLE);
  });
});

describe("Ollama after a reboot", () => {
  async function rebooted(opts: MachineOptions) {
    const m = machine({
      env,
      compose,
      ...opts,
      ollama: { models: { "gemma4:e4b": GEMMA }, ...opts.ollama },
    });
    await run(["--yes", "--json", "--local-model", "gemma4:e4b"], m.deps);
    await run(["down", "--json"], m.deps);
    m.ollamaUp = false;
    m.calls.length = 0;
    return m;
  }

  test("up starts Ollama before NimbleBrain", async () => {
    const m = await rebooted({ platform: "darwin", exec: BREW });
    const body = JSON.parse((await run(["up", "--json"], m.deps)).stdout);
    expect(body.ok).toBe(true);
    expect(body.ollama_started).toBe("brew services start ollama");
    const at = (s: string) => m.calls.findIndex((c) => c.includes(s));
    expect(at("brew services start ollama")).toBeLessThan(at("docker compose up"));
  });

  test("up with Ollama still down starts NimbleBrain and says what is missing", async () => {
    const m = await rebooted({
      files: UNIT,
      exec: { "systemctl start --no-ask-password ollama": fail("Access denied") },
    });
    const body = JSON.parse((await run(["up", "--json"], m.deps)).stdout);
    expect(body.error).toBe("LOCAL_MODEL_UNREACHABLE");
    expect(body.message).toStartWith("NimbleBrain is running, but ");
    expect(body.health).toBe("ok");
    expect(body.fix).toBe(FIX.systemd);
  });

  /** A local-model install whose first start failed, then Ollama stopped before the rerun. */
  async function unfinished(opts: MachineOptions) {
    const m = machine({
      env,
      compose,
      ...opts,
      ollama: { models: { "gemma4:e4b": GEMMA }, ...opts.ollama },
    });
    const exec = m.deps.exec;
    m.deps.exec = async (cmd, args, o) =>
      args.join(" ") === "compose up -d --no-build"
        ? fail("Error response from daemon: boom")
        : exec(cmd, args, o);
    const first = await run(["--yes", "--json", "--local-model", "gemma4:e4b"], m.deps);
    expect(JSON.parse(first.stdout).error).toBe("START_FAILED");
    m.deps.exec = exec;
    m.ollamaUp = false;
    m.calls.length = 0;
    return m;
  }

  test("init resuming a saved local model starts Ollama before NimbleBrain", async () => {
    const m = await unfinished({ platform: "darwin", exec: BREW });
    const body = JSON.parse((await run(["--yes", "--json"], m.deps)).stdout);
    expect(body).toMatchObject({ ok: true, phase: "ready", local_model: "nimblebrain-gemma4-e4b" });
    expect(body.ollama_started).toBe("brew services start ollama");
    const at = (s: string) => m.calls.findIndex((c) => c.includes(s));
    expect(at("brew services start ollama")).toBeLessThan(at("docker compose up"));
  });

  test("init resuming with Ollama still down is LOCAL_MODEL_UNREACHABLE and stays resumable", async () => {
    const m = await unfinished({
      files: UNIT,
      exec: { "systemctl start --no-ask-password ollama": fail("Access denied") },
    });
    const body = JSON.parse((await run(["--yes", "--json"], m.deps)).stdout);
    expect(body.error).toBe("LOCAL_MODEL_UNREACHABLE");
    expect(body.fix).toBe(FIX.systemd);
    expect(m.calls.some((c) => c.includes("docker compose up"))).toBe(false);
    expect(JSON.parse(m.files.get(`${HOME}/install.json`)?.text ?? "").phase).toBe("starting");
  });

  test("up on a hosted key never looks for Ollama", async () => {
    const m = machine({ env, compose, files: UNIT });
    await run(["--yes", "--json"], m.deps);
    m.calls.length = 0;
    const body = JSON.parse((await run(["up", "--json"], m.deps)).stdout);
    expect(body.ok).toBe(true);
    expect(started(m)).toEqual([]);
    expect(m.calls.some((c) => c.includes("brew"))).toBe(false);
  });

  test("a Compose failure after Ollama started still says what was started", async () => {
    const UP = "docker compose up -d --no-build";
    const failingUp = (deps: Deps): Deps => ({
      ...deps,
      exec: (cmd, args, o) =>
        [cmd, ...args].join(" ") === UP
          ? Promise.resolve(fail("container platform exited with code 1"))
          : deps.exec(cmd, args, o),
    });
    const brew = { platform: "darwin", exec: BREW } as const;

    const fresh = machine({
      env,
      compose,
      ...brew,
      ollama: { down: "until-started", models: { "gemma4:e4b": GEMMA } },
    });
    const init = JSON.parse(
      (await run(["--yes", "--json", "--local-model", "gemma4:e4b"], failingUp(fresh.deps))).stdout,
    );
    for (const argv of [["up"], ["local-model", "gemma4:e4b"]]) {
      const m = await rebooted(brew);
      const body = JSON.parse((await run([...argv, "--yes", "--json"], failingUp(m.deps))).stdout);
      expect(body.error).toBe("START_FAILED");
      expect(body.ollama_started).toBe("brew services start ollama");
    }
    expect(init.error).toBe("START_FAILED");
    expect(init.ollama_started).toBe("brew services start ollama");

    // Ollama started but never answered, then Compose failed.
    const m = await rebooted(brew);
    const silent = failingUp(m.deps);
    const body = JSON.parse(
      (
        await run(["up", "--yes", "--json"], {
          ...silent,
          exec: (cmd, args, o) =>
            [cmd, ...args].join(" ") === "brew services start ollama"
              ? Promise.resolve(ok(""))
              : silent.exec(cmd, args, o),
        })
      ).stdout,
    );
    expect(body.error).toBe("START_FAILED");
    expect(body.ollama_started).toBe("brew services start ollama");
  });

  test("doctor without a person reports Ollama down and starts nothing", async () => {
    const m = await rebooted({ platform: "darwin", files: APP });
    const body = JSON.parse((await run(["doctor", "--json"], m.deps)).stdout);
    expect(body.error).toBe("LOCAL_MODEL_UNREACHABLE");
    expect(body.fix).toBe(FIX.app);
    expect(body.checks.at(-1)).toMatchObject({ check: "ollama", ok: false });
    expect(body.checks.some((c: { check: string }) => c.check === "docker")).toBe(true);
    expect(started(m)).toEqual([]);
  });

  test("doctor at a terminal starts Ollama on a yes", async () => {
    const m = await rebooted({ platform: "darwin", files: APP, answers: ["y"] });
    const term = { ...m.deps, interactive: true };
    const { stdout, code } = await run(["doctor"], term);
    expect(code).toBe(0);
    expect(started(m)).toEqual(["$ open -g -a Ollama"]);
    expect(stdout).toContain("ollama: 0.32.5 (started: open -g -a Ollama)");
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
