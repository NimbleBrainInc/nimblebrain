import { describe, expect, test } from "bun:test";
import { chooseServerName } from "../src/agents.ts";
import { run } from "../src/main.ts";
import { CLAUDE_MAX, type MachineOptions, machine, ok, REPO_COMPOSE, record } from "./fake.ts";

/** A second install beside the one in daily use, at the default home on the default ports. */
const LOCAL = "/home/dana/.nimblebrain-local";
const BETA = "/home/dana/.nimblebrain-beta";
const env = { NIMBLEBRAIN_TAG: "v0.73.0" };

async function json(argv: string[], m: ReturnType<typeof machine>) {
  const { stdout, code } = await run([...argv, "--json"], m.deps);
  return { body: JSON.parse(stdout), code };
}

const recordOf = (m: ReturnType<typeof machine>, home: string) =>
  JSON.parse(m.files.get(`${home}/install.json`)?.text ?? "{}");

/** The default install, running on 27246, as an earlier `init` left it. */
const daily = {
  [`${LOCAL}/install.json`]: record({ project: "nimblebrain-local-0a1b2c" }),
  [`${LOCAL}/.env`]: "COMPOSE_PROJECT_NAME=nimblebrain-local-0a1b2c\n",
};

describe("the web port of a new install", () => {
  test("a busy default moves 100 on, named as the other install, and is recorded", async () => {
    const m = machine({ env, files: daily, busyPorts: [27246] });
    const { body } = await json(["--yes", "--home", BETA, "--agent", "none"], m);
    expect(body).toMatchObject({
      ok: true,
      phase: "ready",
      url: "http://127.0.0.1:27346",
      port_moved: { from: 27246, to: 27346, held_by: "nimblebrain", home: LOCAL },
    });
    expect(recordOf(m, BETA).port).toBe(27346);
    expect(m.files.get(`${BETA}/.env`)?.text).toContain("NIMBLEBRAIN_WEB_PORT=27346\n");
    expect(m.said).toContain(
      "Port 27246 is in use (by your NimbleBrain at ~/.nimblebrain-local), so this install uses 27346.",
    );
    // Every later command follows the record.
    expect((await json(["status", "--home", BETA], m)).body.url).toBe("http://127.0.0.1:27346");
  });

  test("a port another install recorded is skipped even when free, and an unknown NimbleBrain is named by its page", async () => {
    const files = {
      ...daily,
      [`${LOCAL}/install.json`]: record({ project: "nimblebrain-local-0a1b2c", port: 27346 }),
    };
    const m = machine({ env, files, busyPorts: [27246], nimblebrainAt: [27246] });
    const { body } = await json(["--yes", "--home", BETA], m);
    expect(body.port_moved).toEqual({ from: 27246, to: 27446, held_by: "nimblebrain", home: null });
    expect(m.said).toContain(
      "Port 27246 is in use (by another NimbleBrain), so this install uses 27446.",
    );
  });

  test("a stopped install's recorded default is skipped though free, named as that install", async () => {
    const m = machine({ env, files: daily });
    const { body } = await json(["--yes", "--home", BETA, "--agent", "none"], m);
    expect(body.port_moved).toEqual({
      from: 27246,
      to: 27346,
      held_by: "nimblebrain",
      home: LOCAL,
    });
    expect(recordOf(m, BETA).port).toBe(27346);
  });

  test("anything else holding it is another program", async () => {
    const m = machine({ env, busyPorts: [27246] });
    const { body } = await json(["--yes", "--home", BETA], m);
    expect(body.port_moved).toEqual({ from: 27246, to: 27346, held_by: "other", home: null });
  });

  test("a free default stays, with no port_moved", async () => {
    const m = machine({ env });
    const { body } = await json(["--yes", "--home", BETA], m);
    expect(body.url).toBe("http://127.0.0.1:27246");
    expect(body.port_moved).toBeUndefined();
  });

  test("an explicit --port that is busy is PORT_IN_USE, and nothing is claimed", async () => {
    const m = machine({ env, busyPorts: [27300] });
    const { body } = await json(["--yes", "--home", BETA, "--port", "27300"], m);
    expect(body.error).toBe("PORT_IN_USE");
    expect(m.files.has(`${BETA}/install.json`)).toBe(false);
  });

  test("with no free port within the tries it is PORT_IN_USE, whose fix names --port", async () => {
    const m = machine({ env, portFree: false });
    const { body } = await json(["--yes", "--home", BETA], m);
    expect(body.error).toBe("PORT_IN_USE");
    expect(body.message).toContain("27246");
    expect(body.fix).toContain("--port");
    expect(m.files.has(`${BETA}/install.json`)).toBe(false);
  });

  test("a resume keeps its recorded port: busy by something else is PORT_IN_USE, never moved", async () => {
    const m = machine({
      env,
      files: { [`${BETA}/install.json`]: record({ phase: "starting", port: 27346 }) },
      busyPorts: [27346],
    });
    const { body } = await json(["--yes", "--home", BETA], m);
    expect(body.error).toBe("PORT_IN_USE");
    expect(recordOf(m, BETA).port).toBe(27346);
  });

  test("doctor in a home with no install reports the port init would take", async () => {
    const m = machine({ env, files: daily, busyPorts: [27246] });
    const { body } = await json(["doctor", "--home", BETA], m);
    expect(body).toMatchObject({
      ok: true,
      port_moved: { from: 27246, to: 27346, held_by: "nimblebrain", home: LOCAL },
    });
    expect(body.checks.at(-1)).toEqual({
      check: "port",
      ok: true,
      detail: "27346 (27246 is in use by your NimbleBrain at ~/.nimblebrain-local)",
    });
    expect((await json(["doctor", "--home", BETA, "--port", "27246"], m)).body.error).toBe(
      "PORT_IN_USE",
    );
  });
});

describe("the coding agent's server name", () => {
  const deps = machine().deps;
  const name = (home: string) => chooseServerName(deps, home, "nimblebrain-x-0a1b2c");

  test("the default home keeps nimblebrain; another takes its folder's name", async () => {
    expect(await name(LOCAL)).toBe("nimblebrain");
    expect(await name(BETA)).toBe("nimblebrain-beta");
    expect(await name("/home/dana/nb-rc")).toBe("nimblebrain-nb-rc");
    expect(await name("/home/dana/NimbleBrain_RC")).toBe("nimblebrain-rc");
    expect(await name("/srv/My Install")).toBe("nimblebrain-my-install");
  });

  test("a folder that gives no slug, or one another install has, falls back to the project", async () => {
    expect(await name("/home/dana/nimblebrain")).toBe("nimblebrain-x-0a1b2c");
    expect(await name("/home/dana/.nimblebrain")).toBe("nimblebrain-x-0a1b2c");
    const other = "/srv/other/.nimblebrain-beta";
    const m = machine({
      env: { NIMBLEBRAIN_HOME: other },
      files: {
        [`${other}/install.json`]: JSON.stringify({
          ...JSON.parse(record()),
          serverName: "nimblebrain-beta",
        }),
      },
    });
    expect(await chooseServerName(m.deps, BETA, "nimblebrain-beta-d51772")).toBe(
      "nimblebrain-beta-d51772",
    );
  });

  test("a second install registers under its own name, beside the first's, and records it", async () => {
    const m = machine({ env, busyPorts: [27246], servers: { claude: ["nimblebrain"] } });
    const { body } = await json(["--yes", "--home", BETA, "--agent", "claude-code"], m);
    expect(body.agent).toMatchObject({ connected: "claude-code", server: "nimblebrain-beta" });
    expect(m.calls).toContain(
      "$ claude mcp add --transport http -s user nimblebrain-beta http://127.0.0.1:27346/mcp/ws_1",
    );
    expect(m.calls).not.toContain("$ claude mcp remove -s user nimblebrain");
    expect([...m.servers.claude].sort()).toEqual(["nimblebrain", "nimblebrain-beta"]);
    expect(recordOf(m, BETA).serverName).toBe("nimblebrain-beta");
    expect((await json(["status", "--home", BETA], m)).body.agent.server).toBe("nimblebrain-beta");
  });

  test("a name the agent already has from elsewhere is left alone; the install takes its project", async () => {
    const m = machine({ env, servers: { codex: ["nimblebrain-beta"] } });
    const { body } = await json(["--yes", "--home", BETA, "--agent", "codex"], m);
    const { project, serverName } = recordOf(m, BETA);
    expect(serverName).toBe(project);
    expect(body.agent.server).toBe(project);
    expect([...m.servers.codex].sort()).toEqual(["nimblebrain-beta", project].sort());
  });

  test("the manual fallback names the install's own server", async () => {
    const m = machine({
      env,
      exec: { "claude mcp get nimblebrain-beta": ok("") },
      servers: {},
    });
    m.deps.exec = (
      (exec) => async (cmd, args, o) =>
        args[1] === "add"
          ? { code: 1, stdout: "", stderr: "nope", missing: false }
          : exec(cmd, args, o)
    )(m.deps.exec);
    const { body } = await json(["--yes", "--home", BETA, "--agent", "claude-code"], m);
    const { project } = recordOf(m, BETA);
    expect(body.manual).toBe(
      `claude mcp add --transport http -s user ${project} http://127.0.0.1:27246/mcp/ws_1`,
    );
  });

  test("Cursor gets the install's own entry beside the others, and uninstall removes only it", async () => {
    const cursor = "/home/dana/.cursor/mcp.json";
    const m = machine({
      env,
      files: { [cursor]: JSON.stringify({ mcpServers: { nimblebrain: { url: "a" } } }) },
    });
    await json(["--yes", "--home", BETA, "--agent", "cursor"], m);
    const servers = () => JSON.parse(m.files.get(cursor)?.text ?? "{}").mcpServers;
    expect(Object.keys(servers()).sort()).toEqual(["nimblebrain", "nimblebrain-beta"]);
    await json(["uninstall", "--yes", "--home", BETA], m);
    expect(servers()).toEqual({ nimblebrain: { url: "a" } });
  });

  test("uninstall removes only its own registration", async () => {
    const m = machine({ env, busyPorts: [27246], servers: { claude: ["nimblebrain"] } });
    await json(["--yes", "--home", BETA, "--agent", "claude-code"], m);
    const { body } = await json(["uninstall", "--yes", "--home", BETA], m);
    expect(body.ok).toBe(true);
    expect(m.calls).toContain("$ claude mcp remove -s user nimblebrain-beta");
    expect(m.calls).not.toContain("$ claude mcp remove -s user nimblebrain");
    expect([...m.servers.claude]).toEqual(["nimblebrain"]);
  });

  test("an older record with no name uninstalls the nimblebrain it registered", async () => {
    const m = machine({
      env,
      files: {
        [`${BETA}/install.json`]: JSON.stringify({ ...JSON.parse(record()), agent: "claude-code" }),
      },
      servers: { claude: ["nimblebrain"] },
    });
    await json(["uninstall", "--yes", "--home", BETA], m);
    expect(m.calls).toContain("$ claude mcp remove -s user nimblebrain");
  });
});

describe("the agent worker's port", () => {
  const ENV = `${BETA}/.env`;
  /** A ready second install on a Mac, beside the default one whose Claude worker holds 27290. */
  function mac(opts: MachineOptions = {}) {
    return machine({
      platform: "darwin",
      ...opts,
      exec: { "claude auth status --json": ok(CLAUDE_MAX), ...opts.exec },
      files: {
        ...daily,
        [`${LOCAL}/agent-worker.json`]: JSON.stringify({ port: 27290, agent: "claude-code" }),
        [`${BETA}/install.json`]: record({ project: "nimblebrain-beta-d51772", port: 27346 }),
        [ENV]: "COMPOSE_PROJECT_NAME=nimblebrain-beta-d51772\n",
        [`${BETA}/docker-compose.yml`]: REPO_COMPOSE,
        "/home/dana/.npm/_npx/1/nimblebrain.js": "// nimblebrain\n",
        ...opts.files,
      },
    });
  }

  test("a busy default moves 100 on, is said, and is recorded in .env and the login item", async () => {
    const m = mac({ busyPorts: [27290] });
    const { body } = await json(["use", "claude", "--home", BETA], m);
    expect(body).toMatchObject({
      ok: true,
      port_moved: { from: 27290, to: 27390, held_by: "agent_worker", home: LOCAL },
    });
    expect(body.agent_runtime.worker.url).toBe("http://127.0.0.1:27390/acp");
    expect(m.files.get(ENV)?.text).toContain(
      "NB_AGENT_RUNTIME_URL=http://host.docker.internal:27390/acp",
    );
    expect(m.spawned.at(-1)?.line).toContain("--port 27390");
    expect(JSON.parse(m.files.get(`${BETA}/agent-worker.json`)?.text ?? "").port).toBe(27390);
    expect(m.said).toContain(
      "Port 27290 is in use (by the agent worker of your NimbleBrain at ~/.nimblebrain-local), so the agent worker uses 27390.",
    );
  });

  test("a stopped worker's recorded default is skipped though free", async () => {
    const m = mac();
    const { body } = await json(["use", "claude", "--home", BETA], m);
    expect(body.port_moved).toEqual({
      from: 27290,
      to: 27390,
      held_by: "agent_worker",
      home: LOCAL,
    });
    expect(JSON.parse(m.files.get(`${BETA}/agent-worker.json`)?.text ?? "").port).toBe(27390);
  });

  test("a free default no other install recorded stays, with no port_moved", async () => {
    const m = mac({
      files: {
        [`${LOCAL}/agent-worker.json`]: JSON.stringify({ port: 27390, agent: "claude-code" }),
      },
    });
    const { body } = await json(["use", "claude", "--home", BETA], m);
    expect(body.agent_runtime.worker.url).toBe("http://127.0.0.1:27290/acp");
    expect(body.port_moved).toBeUndefined();
  });

  test("an explicit busy --port is PORT_IN_USE", async () => {
    const m = mac({ busyPorts: [27500] });
    const { body } = await json(["use", "claude", "--home", BETA, "--port", "27500"], m);
    expect(body.error).toBe("PORT_IN_USE");
    expect(body.message).toContain("27500");
    expect(m.files.get(ENV)?.text).not.toContain("NB_AGENT_RUNTIME");
  });
});
