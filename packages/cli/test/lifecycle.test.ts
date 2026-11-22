import { describe, expect, test } from "bun:test";
import { DEFAULT_PROJECT, keyVars, projectFor, providers } from "../src/compose.ts";
import { run } from "../src/main.ts";
import { compareVersions, MIN_RUNTIME, newestRelease, runtimeTag } from "../src/release.ts";
import { VERSION } from "../src/version.ts";
import { fail, machine, ok, REPO_COMPOSE } from "./fake.ts";

const HOME = "/home/dana/.nimblebrain-local";
const INSTALL = `${HOME}/install.json`;
const ENV = `${HOME}/.env`;
/** What an earlier, unfinished `init` leaves in `.env`: the mark that the home is the CLI's. */
const MARK = `COMPOSE_PROJECT_NAME=${DEFAULT_PROJECT}\n`;
/** Pins the runtime, so a test does not depend on which release is newest. */
const env = { NIMBLEBRAIN_TAG: "v0.73.0" };

async function json(argv: string[], m = machine({ env })) {
  const { stdout, code } = await run([...argv, "--json"], m.deps);
  return { body: JSON.parse(stdout), code, m };
}

describe("the release's Compose file", () => {
  test("names the model-key variables the CLI withholds and offers", () => {
    expect(REPO_COMPOSE).toContain("ghcr.io/nimblebraininc/nimblebrain-runtime:${NIMBLEBRAIN_TAG");
    expect(REPO_COMPOSE).toContain("127.0.0.1:${NIMBLEBRAIN_WEB_PORT:-27246}:8080");
    expect(keyVars(REPO_COMPOSE)).toContain("ANTHROPIC_API_KEY");
    expect(providers(REPO_COMPOSE).anthropic).toBe("ANTHROPIC_API_KEY");
    expect(providers(REPO_COMPOSE).google).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  test("is fetched from the chosen release's tag, before anything is written", async () => {
    const seen: string[] = [];
    const m = machine({ env });
    const getText = m.deps.getText;
    m.deps.getText = async (url, t) => {
      seen.push(url);
      return getText(url, t);
    };
    await json(["--yes"], m);
    expect(seen).toContain(
      "https://raw.githubusercontent.com/NimbleBrainInc/nimblebrain/v0.73.0/docker-compose.yml",
    );
  });

  test("a release whose Compose file cannot be driven is refused, writing nothing", async () => {
    for (const compose of [
      { status: 404, body: "404: Not Found" },
      { status: 200, body: "services:\n  platform:\n    image: nimblebrain:latest\n" },
    ]) {
      const m = machine({ env, compose });
      const { body } = await json(["--yes"], m);
      expect(body.error).toBe("RUNTIME_UNSUPPORTED");
      expect(m.files.size).toBe(0);
    }
  });

  test("a Compose file that cannot be downloaded is NETWORK", async () => {
    const m = machine({ env, compose: null });
    expect((await json(["--yes"], m)).body.error).toBe("NETWORK");
  });
});

describe("init", () => {
  test("runs every Compose command through a standalone docker-compose v2 when Docker has no plugin", async () => {
    const m = machine({
      env,
      exec: {
        "docker compose version --short": fail("docker: 'compose' is not a docker command."),
        "docker-compose version --short": ok("2.29.1"),
      },
    });
    const { body } = await json(["--yes"], m);
    expect(body).toMatchObject({ ok: true, health: "ok" });
    expect(m.calls).toContain("$ docker-compose ls -a --format json");
    expect(m.calls).toContain(`${HOME}$ docker-compose up -d --no-build`);
    expect(m.calls.filter((c) => c.includes("docker compose ") && !c.includes("version"))).toEqual(
      [],
    );
    // One lookup per run, however many Compose commands it runs.
    expect(m.calls.filter((c) => c.endsWith("docker-compose version --short"))).toHaveLength(1);
    const down = await json(["down"], m);
    expect(down.body.ok).toBe(true);
    expect(m.calls).toContain(`${HOME}$ docker-compose down`);
  });

  test("an agent's unattended run installs, starts, connects, and succeeds with model_key missing", async () => {
    const { body, code, m } = await json(["--yes", "--agent", "claude-code"]);
    expect(code).toBe(0);
    expect(body).toMatchObject({
      ok: true,
      model_key: "missing",
      local_model: null,
      health: "ok",
      version: "0.73.0",
      cli_version: VERSION,
      url: "http://127.0.0.1:27246",
      workspaces: [{ id: "ws_1", mcp: "http://127.0.0.1:27246/mcp/ws_1" }],
      agent: { connected: "claude-code", skill: "nimblebrain" },
    });
    expect(m.calls).toContain(
      "$ claude mcp add --transport http -s user nimblebrain http://127.0.0.1:27246/mcp/ws_1",
    );
    expect(
      m.calls.some((c) =>
        c.includes("skills add nimblebraininc/skills --skill nimblebrain --agent claude-code"),
      ),
    ).toBe(true);
  });

  test("writes the release's Compose file, the dev adapter, and a .env readable by this user only", async () => {
    const { m } = await json(["--yes"]);
    expect(m.files.get(`${HOME}/docker-compose.yml`)?.text).toBe(REPO_COMPOSE);
    expect(JSON.parse(m.files.get(`${HOME}/instance.json`)?.text ?? "")).toEqual({
      auth: { adapter: "dev" },
    });
    const dotenv = m.files.get(ENV);
    expect(dotenv?.mode).toBe(0o600);
    expect(dotenv?.text).toContain(`COMPOSE_PROJECT_NAME=${DEFAULT_PROJECT}`);
    expect(dotenv?.text).toContain("NIMBLEBRAIN_TAG=v0.73.0");
    expect(dotenv?.text).toContain("NIMBLEBRAIN_WEB_PORT=27246");
  });

  test("starts without building and without the shell's keys, so .env is the one source", async () => {
    const m = machine({
      env: { ...env, ANTHROPIC_API_KEY: "sk-shell", NIMBLEBRAIN_WEB_PORT: "1" },
    });
    await json(["--yes"], m);
    expect(m.calls).toContain(`${HOME}$ docker compose up -d --no-build`);
    for (const e of m.composeEnvs) {
      expect(e.ANTHROPIC_API_KEY).toBeUndefined();
      expect(e.NIMBLEBRAIN_TAG).toBeUndefined();
      expect(e.NIMBLEBRAIN_WEB_PORT).toBeUndefined();
    }
  });

  test("--port moves the published port", async () => {
    const { body, m } = await json(["--yes", "--port", "28000"]);
    expect(m.files.get(ENV)?.text).toContain("NIMBLEBRAIN_WEB_PORT=28000");
    expect(body.url).toBe("http://127.0.0.1:28000");
  });

  test("with a key in .env it ends ok", async () => {
    const m = machine({ env, files: { [ENV]: `${MARK}ANTHROPIC_API_KEY=sk-test\n` } });
    const { body, code } = await json(["--yes"], m);
    expect(code).toBe(0);
    expect(body).toMatchObject({ ok: true, model_key: "set" });
    expect(m.files.get(ENV)?.text).toContain("ANTHROPIC_API_KEY=sk-test");
  });

  test("the key never appears in the output", async () => {
    const m = machine({ env, files: { [ENV]: `${MARK}ANTHROPIC_API_KEY=sk-secret-123\n` } });
    const { stdout } = await run(["--yes", "--json"], m.deps);
    expect(stdout).not.toContain("sk-secret-123");
  });

  test("running it again reports the install and changes nothing", async () => {
    const m = machine({ env });
    await json(["--yes"], m);
    const before = m.calls.length;
    const { body } = await json(["--yes"], m);
    expect(body).toMatchObject({ ok: true, already: true });
    expect(m.calls.slice(before).some((c) => c.includes("compose up"))).toBe(false);
  });

  test("a person at the terminal is asked to confirm, for the model, the key, and an agent", async () => {
    // The model question's empty answer is a hosted model, so the key is asked next.
    const m = machine({ env, interactive: true, answers: ["", "", "", "sk-typed", "none"] });
    const exec = m.deps.exec;
    const envAtStart: string[] = [];
    m.deps.exec = async (cmd, args, o) => {
      if (args.join(" ").startsWith("compose up")) envAtStart.push(m.files.get(ENV)?.text ?? "");
      return exec(cmd, args, o);
    };
    const { stdout, code } = await run([], m.deps);
    expect(code).toBe(0);
    expect(stdout).not.toContain("sk-typed");
    expect(envAtStart).toHaveLength(1);
    expect(envAtStart[0]).toContain("ANTHROPIC_API_KEY=sk-typed");
    expect(m.asked[1]).toStartWith("Model (hosted, local)");
  });

  test("a person reads a plain summary: what the agent got, a missing skill, what to do next", async () => {
    const m = machine({
      env,
      interactive: true,
      answers: ["", "", "", "sk-typed", "claude-code"],
      exec: {
        "npx -y skills add nimblebraininc/skills --skill nimblebrain --agent claude-code -g -y":
          fail(),
      },
    });
    const { stdout, code } = await run([], m.deps);
    expect(code).toBe(0);
    expect(stdout).toContain("NimbleBrain v0.73.0: running at http://127.0.0.1:27246");
    expect(stdout).toContain("model key: set (NimbleBrain's own agents use it)");
    expect(stdout).toContain("Claude Code can use NimbleBrain's tools");
    expect(stdout).toContain(
      "skill: not installed; add it with npx skills add nimblebraininc/skills --skill nimblebrain --agent claude-code -g",
    );
    expect(stdout).toContain(
      "Next: use NimbleBrain in your browser at http://127.0.0.1:27246, or ask Claude Code",
    );
    expect(stdout).toContain("telemetry: off (no_destination)");
    expect(stdout).not.toContain("undefined");
    expect(stdout).not.toContain("{");
    expect(m.asked.at(-1)).toStartWith("Connect a coding agent?");
  });

  test("a rerun's summary has no next step and the skill line only when it is missing", async () => {
    const m = machine({ env, interactive: true, answers: ["", "", "", "sk-typed", "claude-code"] });
    await run([], m.deps);
    const { stdout } = await run([], m.deps);
    expect(stdout).toContain("already installed");
    expect(stdout).not.toContain("Next:");
    expect(stdout).not.toContain("skill:");
    expect(stdout).toContain("Claude Code can use NimbleBrain's tools");
  });

  test("status reads the skill from the agent's skills folder, so one added or removed later counts", async () => {
    const m = machine({
      env,
      exec: {
        "npx -y skills add nimblebraininc/skills --skill nimblebrain --agent claude-code -g -y":
          fail(),
      },
    });
    await json(["--yes", "--agent", "claude-code"], m);
    expect((await json(["status"], m)).body.agent).toEqual({
      connected: "claude-code",
      skill: null,
    });
    const skill = "/home/dana/.claude/skills/nimblebrain/SKILL.md";
    m.files.set(skill, { text: "", mode: 0o644 });
    expect((await json(["status"], m)).body.agent.skill).toBe("nimblebrain");
    m.files.delete(skill);
    expect((await json(["status"], m)).body.agent.skill).toBeNull();
  });

  test("CLAUDE_CONFIG_DIR moves Claude Code's skills folder", async () => {
    const m = machine({ env: { ...env, CLAUDE_CONFIG_DIR: "/cfg/claude" } });
    await json(["--yes", "--agent", "claude-code"], m);
    expect((await json(["status"], m)).body.agent.skill).toBeNull();
    m.files.set("/cfg/claude/skills/nimblebrain/SKILL.md", { text: "", mode: 0o644 });
    expect((await json(["status"], m)).body.agent.skill).toBe("nimblebrain");
  });

  test("declining the confirmation installs nothing", async () => {
    const m = machine({ env, interactive: true, answers: ["n"] });
    const { stdout } = await run(["--json"], machine({ env }).deps);
    expect(JSON.parse(stdout)).toBeDefined();
    const res = await run([], m.deps);
    expect(res.code).toBe(1);
    expect(m.files.size).toBe(0);
  });

  test("another install's project refuses with NOT_OURS before writing anything", async () => {
    const m = machine({
      env,
      exec: {
        "docker compose ls -a --format json": ok(
          '[{"Name":"nimblebrain-local","ConfigFiles":"/srv/x/docker-compose.yml"}]',
        ),
      },
    });
    const { body } = await json(["--yes"], m);
    expect(body.error).toBe("NOT_OURS");
    expect(m.files.size).toBe(0);
  });

  test("a --home holding files this CLI did not write refuses with NOT_OURS and keeps them", async () => {
    const compose = "/home/dana/project/docker-compose.yml";
    const m = machine({ env, files: { [compose]: "services: {}\n" } });
    const { body } = await json(["--yes", "--home", "/home/dana/project"], m);
    expect(body.error).toBe("NOT_OURS");
    expect(m.files.get(compose)?.text).toBe("services: {}\n");
    expect(m.files.size).toBe(1);
  });

  test("a failed pull over the network is NETWORK", async () => {
    const m = machine({
      env,
      exec: { "docker compose up -d --no-build": fail("dial tcp: lookup ghcr.io: no such host") },
    });
    expect((await json(["--yes"], m)).body.error).toBe("NETWORK");
  });

  test("a runtime that never answers health is HEALTH_TIMEOUT", async () => {
    const m = machine({ env });
    m.deps.getJson = async () => undefined;
    expect((await json(["--yes"], m)).body.error).toBe("HEALTH_TIMEOUT");
  });

  test("with no --runtime it installs the newest plain release", async () => {
    const m = machine({
      tags: ["server-sdk-py/v0.9.0", "v0.75.0-rc.1", "v0.73.0", "v0.74.0", "v0.9.0"],
    });
    await json(["--yes"], m);
    expect(m.files.get(ENV)?.text).toContain("NIMBLEBRAIN_TAG=v0.74.0");
  });

  test("--runtime installs the release it names", async () => {
    const m = machine({ tags: ["v0.75.0"] });
    await json(["--yes", "--runtime", "v0.74.0"], m);
    expect(m.files.get(ENV)?.text).toContain("NIMBLEBRAIN_TAG=v0.74.0");
  });

  test("a runtime older than the CLI supports is refused, writing nothing", async () => {
    const m = machine();
    const { body } = await json(["--yes", "--runtime", "v0.72.0"], m);
    expect(body.error).toBe("RUNTIME_UNSUPPORTED");
    expect(m.files.size).toBe(0);
  });
});

describe("another home", () => {
  const RC = "/home/dana/nb-rc";
  /** Docker as it is with the default install present: its project and its data volume. */
  const defaultInstalled = {
    "docker compose ls -a --format json": ok(
      '[{"Name":"nimblebrain-local","ConfigFiles":"/home/dana/.nimblebrain-local/docker-compose.yml"}]',
    ),
    "docker volume ls -q --filter name=^nimblebrain-local_workspace$": ok(
      "nimblebrain-local_workspace",
    ),
  };

  test("the project follows the home folder's name, and the default home keeps nimblebrain-local", () => {
    expect(projectFor("/home/dana/.nimblebrain-local")).toBe("nimblebrain-local");
    expect(projectFor("/tmp/tmp.x1/nimblebrain-local")).toBe("nimblebrain-local");
    expect(projectFor("/home/dana/nb-rc")).toBe("nimblebrain-nb-rc");
    expect(projectFor("/home/dana/nb-rc/")).toBe("nimblebrain-nb-rc");
    expect(projectFor("/home/dana/.nimblebrain-local-rc")).toBe("nimblebrain-local-rc");
    expect(projectFor("/home/dana/RC 0.80.0")).toBe("nimblebrain-rc-0-80-0");
    expect(projectFor("/")).toBe("nimblebrain");
  });

  test("installs beside the default install as its own project, port and data", async () => {
    const m = machine({ env, exec: defaultInstalled });
    const { body } = await json(["--yes", "--home", RC, "--port", "27300"], m);
    expect(body).toMatchObject({ ok: true, model_key: "missing", url: "http://127.0.0.1:27300" });
    expect(m.files.get(`${RC}/.env`)?.text).toContain("COMPOSE_PROJECT_NAME=nimblebrain-nb-rc\n");
    expect(JSON.parse(m.files.get(`${RC}/install.json`)?.text ?? "")).toMatchObject({
      project: "nimblebrain-nb-rc",
      port: 27300,
    });
    expect(m.calls).toContain(`${RC}$ docker compose up -d --no-build`);
  });

  test("a relative --home is taken from the working directory", async () => {
    const m = machine({ env, exec: defaultInstalled });
    await json(["--yes", "--home", "../nb-rc", "--port", "27300"], m);
    expect(m.files.get(`${RC}/.env`)?.text).toContain("COMPOSE_PROJECT_NAME=nimblebrain-nb-rc\n");
  });

  test("a home whose own project is taken refuses with NOT_OURS, naming it", async () => {
    const m = machine({
      env,
      exec: { "docker compose ls -a --format json": ok('[{"Name":"nimblebrain-nb-rc"}]') },
    });
    const { body } = await json(["--yes", "--home", RC], m);
    expect(body.error).toBe("NOT_OURS");
    expect(body.message).toContain('"nimblebrain-nb-rc"');
    expect(m.files.size).toBe(0);
  });

  test("a project whose name only starts with this one is not this one", async () => {
    const m = machine({
      env,
      exec: { "docker compose ls -a --format json": ok('[{"Name":"nimblebrain-local-rc"}]') },
    });
    expect((await json(["--yes"], m)).body).toMatchObject({ ok: true, model_key: "missing" });
  });

  test("a .env naming another project is not this home's mark", async () => {
    const m = machine({ env, files: { [ENV]: "COMPOSE_PROJECT_NAME=nimblebrain-local-rc\n" } });
    const { body } = await json(["--yes"], m);
    expect(body.error).toBe("NOT_OURS");
    expect(m.files.get(ENV)?.text).toBe("COMPOSE_PROJECT_NAME=nimblebrain-local-rc\n");
  });

  test("an older CLI's unfinished init in another home resumes on the project it chose", async () => {
    const m = machine({ env, files: { [`${RC}/.env`]: MARK } });
    await json(["--yes", "--home", RC, "--port", "27300"], m);
    expect(m.files.get(`${RC}/.env`)?.text).toContain(`COMPOSE_PROJECT_NAME=${DEFAULT_PROJECT}\n`);
    expect(JSON.parse(m.files.get(`${RC}/install.json`)?.text ?? "").project).toBe(DEFAULT_PROJECT);
  });

  test("update keeps the project the install recorded", async () => {
    const m = machine({ env, exec: defaultInstalled });
    await json(["--yes", "--home", RC, "--port", "27300"], m);
    await json(["update", "--home", RC, "--runtime", "v0.74.0"], m);
    const dotenv = m.files.get(`${RC}/.env`)?.text ?? "";
    expect(dotenv).toContain("NIMBLEBRAIN_TAG=v0.74.0");
    expect(dotenv).toContain("COMPOSE_PROJECT_NAME=nimblebrain-nb-rc\n");
    expect(dotenv).not.toContain(`COMPOSE_PROJECT_NAME=${DEFAULT_PROJECT}\n`);
  });
});

describe("after install", () => {
  async function installed() {
    const m = machine({ env, files: { [ENV]: `${MARK}ANTHROPIC_API_KEY=sk-test\n` } });
    await json(["--yes", "--agent", "claude-code"], m);
    return m;
  }

  test("down stops it and keeps data; up starts it", async () => {
    const m = await installed();
    expect((await json(["down"], m)).body).toEqual({ ok: true, health: "down" });
    expect(m.calls.at(-1)).toBe(`${HOME}$ docker compose down`);
    expect((await json(["up"], m)).body.health).toBe("ok");
  });

  test("logs returns the runtime's lines", async () => {
    const m = machine({
      env,
      files: { [ENV]: `${MARK}ANTHROPIC_API_KEY=sk\n` },
      exec: { "docker compose logs --no-color --tail 100 platform": ok("a\nb\n") },
    });
    await json(["--yes"], m);
    expect((await json(["logs"], m)).body.lines).toEqual(["a", "b"]);
  });

  test("key needs a person at a terminal", async () => {
    const m = await installed();
    expect((await json(["key"], m)).body.error).toBe("NEEDS_TERMINAL");
  });

  test("key stores the entered key with mode 600 and recreates the runtime", async () => {
    const m = await installed();
    m.deps.interactive = true;
    const answers = ["openai", "sk-openai"];
    m.deps.prompt = async () => answers.shift() ?? "";
    const { body } = await json(["key"], m);
    expect(body).toEqual({ ok: true, provider: "openai", model_key: "set" });
    expect(m.files.get(ENV)?.mode).toBe(0o600);
    expect(m.files.get(ENV)?.text).toContain("OPENAI_API_KEY=sk-openai");
    expect(m.calls.at(-1)).toBe(`${HOME}$ docker compose up -d --no-build`);
  });

  test("update moves forward, keeps the port, and refuses to move back", async () => {
    const m = await installed();
    m.deps.env = {};
    const { body } = await json(["update", "--runtime", "v0.74.0"], m);
    expect(body).toMatchObject({ ok: true, version: "0.74.0", from: "v0.73.0" });
    expect(m.files.get(ENV)?.text).toContain("NIMBLEBRAIN_TAG=v0.74.0");
    expect((await json(["update", "--runtime", "v0.73.0"], m)).body.error).toBe("USAGE");
    expect((await json(["update", "--runtime", "v0.74.0-rc.1"], m)).body.error).toBe("USAGE");
    expect((await json(["update", "--runtime", "latest"], m)).body.error).toBe("USAGE");
    expect(m.files.get(ENV)?.text).toContain("NIMBLEBRAIN_TAG=v0.74.0");
    const { stdout } = await run(["update", "--runtime", "v0.75.0"], m.deps);
    expect(stdout).toContain("updated from v0.74.0");
  });

  describe("update refreshes the agent's skill", () => {
    const REFRESH = "$ npx -y skills update nimblebrain -g -y";
    async function withAgent(exec: Record<string, ReturnType<typeof ok>> = {}) {
      const m = machine({ env, files: { [ENV]: `${MARK}ANTHROPIC_API_KEY=sk-test\n` }, exec });
      await json(["--yes", "--agent", "claude-code"], m);
      m.deps.env = { NIMBLEBRAIN_NO_UPDATE_CHECK: "1" };
      return m;
    }

    test("after moving the runtime, reporting a changed skill as updated", async () => {
      const m = await withAgent({
        "npx -y skills update nimblebrain -g -y": ok("\n✓ Updated 1 skill(s)\n"),
      });
      const { body } = await json(["update", "--runtime", "v0.74.0"], m);
      expect(body).toMatchObject({ ok: true, from: "v0.73.0", skill_update: "updated" });
      expect(m.calls).toContain(REFRESH);
      const { stdout } = await run(["update", "--runtime", "v0.75.0"], m.deps);
      expect(stdout).toContain("skill: updated to the newest nimblebrain skill");
    });

    test("on a runtime already current too", async () => {
      const m = await withAgent();
      const { body } = await json(["update", "--runtime", "v0.73.0"], m);
      expect(body).toMatchObject({ ok: true, already: true, skill_update: "unchanged" });
      expect(m.calls).toContain(REFRESH);
    });

    test("a failed refresh is reported, never an error", async () => {
      for (const res of [fail("network"), { code: null, stdout: "", stderr: "", missing: true }]) {
        const m = await withAgent({ "npx -y skills update nimblebrain -g -y": res });
        const { body, code } = await json(["update", "--runtime", "v0.74.0"], m);
        expect(code).toBe(0);
        expect(body).toMatchObject({ ok: true, version: "0.74.0", skill_update: "failed" });
      }
    });

    test("a skill that is not there is not added back, and no agent means no refresh", async () => {
      const m = await withAgent();
      m.files.delete("/home/dana/.claude/skills/nimblebrain/SKILL.md");
      const { body } = await json(["update", "--runtime", "v0.74.0"], m);
      expect(body.skill_update).toBe("not_installed");
      expect(m.calls).not.toContain(REFRESH);

      const none = machine({ env, files: { [ENV]: `${MARK}ANTHROPIC_API_KEY=sk-test\n` } });
      await json(["--yes"], none);
      none.deps.env = { NIMBLEBRAIN_NO_UPDATE_CHECK: "1" };
      const plain = await json(["update", "--runtime", "v0.74.0"], none);
      expect(plain.body.skill_update).toBeUndefined();
      expect(none.calls.some((c) => c.includes("skills update"))).toBe(false);
    });
  });

  test("uninstall without --yes from an agent changes nothing", async () => {
    const m = await installed();
    expect((await json(["uninstall"], m)).body.error).toBe("CANCELLED");
    expect(m.files.has(INSTALL)).toBe(true);
  });

  test("uninstall --yes removes containers, volume, images, the agent's server and the folder", async () => {
    const m = await installed();
    const { body } = await json(["uninstall", "--yes"], m);
    expect(body).toEqual({ ok: true, removed: true });
    expect(m.calls).toContain(`${HOME}$ docker compose down -v --rmi all`);
    expect(m.calls).toContain("$ claude mcp remove -s user nimblebrain");
    expect(m.files.has(INSTALL)).toBe(false);
  });

  test("uninstall removes only the files init wrote", async () => {
    const m = await installed();
    m.files.set(`${HOME}/notes.txt`, { text: "mine", mode: 0o644 });
    await json(["uninstall", "--yes"], m);
    // The agent's skill stays: it is how the agent installs NimbleBrain again.
    expect([...m.files.keys()].sort()).toEqual(
      [`${HOME}/notes.txt`, "/home/dana/.claude/skills/nimblebrain/SKILL.md"].sort(),
    );
  });

  test("a stopped Docker is DOCKER_NOT_RUNNING for up, down, logs and uninstall", async () => {
    const stopped = [
      "failed to connect to the docker API at unix:///home/dana/.colima/default/docker.sock; check if the path is correct and if the daemon is running: dial unix /home/dana/.colima/default/docker.sock: connect: no such file or directory",
      "Cannot connect to the Docker daemon at unix:///home/dana/.docker/run/docker.sock. Is the docker daemon running?",
      // A stale socket answers "connection refused", which alone would read as NETWORK.
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running? dial unix /var/run/docker.sock: connect: connection refused",
    ];
    for (const stderr of stopped) {
      for (const cmd of ["up", "down", "logs", "uninstall"]) {
        const m = await installed();
        const real = m.deps.exec;
        m.deps.exec = async (c, a, o) =>
          c === "docker" && a[0] === "compose" && a[1] !== "version" ? fail(stderr) : real(c, a, o);
        const { body } = await json([cmd, "--yes"], m);
        expect(body.error).toBe("DOCKER_NOT_RUNNING");
        expect(body.fix).not.toContain("logs");
        expect(body.fix).toContain(
          stderr.includes(".colima/default/") ? "colima start" : "Start Docker Desktop",
        );
      }
    }
  });

  test("commands on a machine with no install say NOT_INSTALLED", async () => {
    for (const cmd of ["up", "down", "logs", "update"]) {
      expect((await json([cmd])).body.error).toBe("NOT_INSTALLED");
    }
  });
});

describe("releases", () => {
  test("the runtime is --runtime, else NIMBLEBRAIN_TAG, else the newest release; never below the minimum", async () => {
    const m = machine({ tags: ["v0.80.0", "v0.79.0"] });
    expect(await runtimeTag(m.deps, "v0.74.0")).toBe("v0.74.0");
    m.deps.env = { NIMBLEBRAIN_TAG: "v0.75.0" };
    expect(await runtimeTag(m.deps)).toBe("v0.75.0");
    m.deps.env = {};
    expect(await runtimeTag(m.deps)).toBe("v0.80.0");
    expect(await runtimeTag(m.deps, MIN_RUNTIME)).toBe(MIN_RUNTIME);
    await expect(runtimeTag(m.deps, "v0.72.9")).rejects.toMatchObject({
      code: "RUNTIME_UNSUPPORTED",
    });
  });

  test("GitHub refusing the lookup says so and points at --runtime", async () => {
    const m = machine();
    m.deps.getText = async () => ({ status: 403, body: "rate limited" });
    await expect(runtimeTag(m.deps)).rejects.toMatchObject({
      code: "NETWORK",
      message: expect.stringContaining("answered 403"),
    });
    await expect(runtimeTag(m.deps)).rejects.toMatchObject({
      message: expect.stringContaining("--runtime"),
    });
  });

  test("newest plain tag wins; SDK tags and pre-releases do not count", () => {
    expect(newestRelease(["v0.9.0", "v0.10.0", "v0.10.1-rc.1", "server-sdk-py/v1.0.0"])).toBe(
      "v0.10.0",
    );
    expect(compareVersions("v0.10.0", "v0.9.9")).toBeGreaterThan(0);
  });

  test("a pre-release sorts before its release, by SemVer precedence", () => {
    expect(compareVersions("v0.70.0-rc.1", "v0.70.0")).toBeLessThan(0);
    expect(compareVersions("v0.70.0", "v0.70.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("v0.70.0-rc.2", "v0.70.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("v0.70.0-rc.1", "v0.70.0-rc.1.1")).toBeLessThan(0);
    expect(compareVersions("v0.70.0-1", "v0.70.0-alpha")).toBeLessThan(0);
    expect(compareVersions("v0.71.0-rc.1", "v0.70.0")).toBeGreaterThan(0);
    expect(compareVersions("v0.70.0", "v0.70.0")).toBe(0);
  });
});

describe("details that are easy to get wrong", () => {
  test("the hidden prompt handles backspace, Enter and Ctrl-C", async () => {
    const { typeHidden } = await import("../src/deps.ts");
    expect(typeHidden("", "sk-ab\u007fc\r")).toEqual({ value: "sk-ac", end: "enter" });
    expect(typeHidden("sk", "\u0003")).toEqual({ value: "sk", end: "cancel" });
    expect(typeHidden("", "abc")).toEqual({ value: "abc" });
  });

  test("connecting Cursor keeps the other servers in its config", async () => {
    const cursor = "/home/dana/.cursor/mcp.json";
    const m = machine({
      env,
      files: {
        [ENV]: `${MARK}ANTHROPIC_API_KEY=sk\n`,
        [cursor]: '{"mcpServers":{"github":{"url":"https://x"}}}',
      },
    });
    await json(["--yes", "--agent", "cursor"], m);
    expect(JSON.parse(m.files.get(cursor)?.text ?? "")).toEqual({
      mcpServers: {
        github: { url: "https://x" },
        nimblebrain: { url: "http://127.0.0.1:27246/mcp/ws_1" },
      },
    });
  });

  test("an agent whose CLI is missing still gets a working install and the settings to add by hand", async () => {
    const m = machine({
      env,
      files: { [ENV]: `${MARK}ANTHROPIC_API_KEY=sk\n` },
      exec: {
        "claude mcp add --transport http -s user nimblebrain http://127.0.0.1:27246/mcp/ws_1": fail(
          "",
          127,
        ),
      },
    });
    const { body, code } = await json(["--yes", "--agent", "claude-code"], m);
    expect(code).toBe(0);
    expect(body.agent.connected).toBeNull();
    expect(body.manual).toContain("claude mcp add");
  });
});
