import { describe, expect, test } from "bun:test";
import { COMPOSE_FILE, KEY_VARS, PROJECT, PROVIDERS } from "../src/compose.ts";
import { run } from "../src/main.ts";
import { compareVersions, newestRelease } from "../src/release.ts";
import { fail, machine, ok } from "./fake.ts";

const HOME = "/home/dana/.nimblebrain-local";
const INSTALL = `${HOME}/install.json`;
const ENV = `${HOME}/.env`;
/** A dev build of the CLI pins no release, so tests pin one the way a release build would. */
const env = { NIMBLEBRAIN_TAG: "v0.70.0" };

async function json(argv: string[], m = machine({ env })) {
  const { stdout, code } = await run([...argv, "--json"], m.deps);
  return { body: JSON.parse(stdout), code, m };
}

describe("the embedded Compose file", () => {
  test("is the release's own, and names the model-key variables", () => {
    expect(COMPOSE_FILE).toContain("ghcr.io/nimblebraininc/nimblebrain-runtime:${NIMBLEBRAIN_TAG");
    expect(COMPOSE_FILE).toContain("127.0.0.1:${NIMBLEBRAIN_WEB_PORT:-27246}:8080");
    expect(KEY_VARS).toContain("ANTHROPIC_API_KEY");
    expect(PROVIDERS.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(PROVIDERS.google).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });
});

describe("init", () => {
  test("an agent's unattended run installs, starts, connects, and ends on MODEL_KEY_MISSING with the status", async () => {
    const { body, code, m } = await json(["--yes", "--agent", "claude-code"]);
    expect(code).toBe(1);
    expect(body).toMatchObject({
      ok: false,
      error: "MODEL_KEY_MISSING",
      health: "ok",
      version: "0.70.0",
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
    expect(m.files.get(`${HOME}/docker-compose.yml`)?.text).toBe(COMPOSE_FILE);
    expect(JSON.parse(m.files.get(`${HOME}/instance.json`)?.text ?? "")).toEqual({
      auth: { adapter: "dev" },
    });
    const dotenv = m.files.get(ENV);
    expect(dotenv?.mode).toBe(0o600);
    expect(dotenv?.text).toContain(`COMPOSE_PROJECT_NAME=${PROJECT}`);
    expect(dotenv?.text).toContain("NIMBLEBRAIN_TAG=v0.70.0");
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
    const m = machine({ env, files: { [ENV]: "ANTHROPIC_API_KEY=sk-test\n" } });
    const { body, code } = await json(["--yes"], m);
    expect(code).toBe(0);
    expect(body).toMatchObject({ ok: true, model_key: "set" });
    expect(m.files.get(ENV)?.text).toContain("ANTHROPIC_API_KEY=sk-test");
  });

  test("the key never appears in the output", async () => {
    const m = machine({ env, files: { [ENV]: "ANTHROPIC_API_KEY=sk-secret-123\n" } });
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

  test("a person at the terminal is asked to confirm, for the key, and for an agent", async () => {
    const m = machine({ env, interactive: true, answers: ["", "", "sk-typed", "none"] });
    const { stdout, code } = await run([], m.deps);
    expect(code).toBe(0);
    expect(stdout).not.toContain("sk-typed");
    expect(m.files.get(ENV)?.text).toContain("ANTHROPIC_API_KEY=sk-typed");
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

  test("a dev build installs the newest plain release tag", async () => {
    const m = machine({
      tags: ["server-sdk-py/v0.9.0", "v0.72.0-rc.1", "v0.71.0", "v0.72.0", "v0.9.0"],
    });
    await json(["--yes"], m);
    expect(m.files.get(ENV)?.text).toContain("NIMBLEBRAIN_TAG=v0.72.0");
  });
});

describe("after install", () => {
  async function installed() {
    const m = machine({ env, files: { [ENV]: "ANTHROPIC_API_KEY=sk-test\n" } });
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
      files: { [ENV]: "ANTHROPIC_API_KEY=sk\n" },
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
    m.deps.env = { NIMBLEBRAIN_TAG: "v0.71.0" };
    const { body } = await json(["update"], m);
    expect(body).toMatchObject({ ok: true, version: "0.71.0", from: "v0.70.0" });
    expect(m.files.get(ENV)?.text).toContain("NIMBLEBRAIN_TAG=v0.71.0");
    m.deps.env = { NIMBLEBRAIN_TAG: "v0.69.0" };
    expect((await json(["update"], m)).body.error).toBe("USAGE");
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

  test("commands on a machine with no install say NOT_INSTALLED", async () => {
    for (const cmd of ["up", "down", "logs", "update"]) {
      expect((await json([cmd])).body.error).toBe("NOT_INSTALLED");
    }
  });
});

describe("releases", () => {
  test("newest plain tag wins; SDK tags and pre-releases do not count", () => {
    expect(newestRelease(["v0.9.0", "v0.10.0", "v0.10.1-rc.1", "server-sdk-py/v1.0.0"])).toBe(
      "v0.10.0",
    );
    expect(compareVersions("v0.10.0", "v0.9.9")).toBeGreaterThan(0);
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
        [ENV]: "ANTHROPIC_API_KEY=sk\n",
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
      files: { [ENV]: "ANTHROPIC_API_KEY=sk\n" },
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
