import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deps, type ExecResult, realDeps } from "../src/deps.ts";
import { interrupted, run, VERSION } from "../src/main.ts";
import { fail, GB, machine, missing, ok, record } from "./fake.ts";

/** A machine where everything passes unless a test overrides one answer. */
function fakeDeps(over: Partial<Deps> & { execMap?: Record<string, ExecResult> } = {}): Deps {
  const { execMap, ...rest } = over;
  return { ...machine({ exec: execMap }).deps, ...rest };
}

async function json(argv: string[], deps = fakeDeps()) {
  const { stdout, code } = await run([...argv, "--json"], deps);
  return { body: JSON.parse(stdout), code };
}

describe("arguments", () => {
  test("an unknown flag is a usage error, exit 2, with a fix", async () => {
    const { body, code } = await json(["status", "--colour"]);
    expect(code).toBe(2);
    expect(body).toMatchObject({ ok: false, error: "USAGE" });
    expect(typeof body.fix).toBe("string");
  });

  test("an unknown agent names the agents it takes", async () => {
    const { body, code } = await json(["--agent", "vim"]);
    expect(code).toBe(1);
    expect(body.error).toBe("AGENT_UNSUPPORTED");
  });

  test("a port that is not a number is a usage error", async () => {
    expect((await json(["doctor", "--port", "abc"])).code).toBe(2);
  });

  test("--version answers in JSON", async () => {
    expect((await json(["--version"])).body).toEqual({ ok: true, version: VERSION });
  });

  test("help prints the commands and exits 0", async () => {
    const { stdout, code } = await run(["--help"], fakeDeps());
    expect(code).toBe(0);
    expect(stdout).toContain("doctor");
  });
});

describe("doctor", () => {
  test("a ready machine passes every check", async () => {
    const { body, code } = await json(["doctor"]);
    expect(code).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.checks.map((c: { check: string }) => c.check)).toEqual([
      "docker",
      "docker-daemon",
      "compose",
      "arch",
      "memory",
      "port",
    ]);
  });

  test("no docker binary is DOCKER_MISSING", async () => {
    const deps = fakeDeps({
      execMap: { "docker --version": { code: null, stdout: "", stderr: "", missing: true } },
    });
    const { body } = await json(["doctor"], deps);
    expect(body).toMatchObject({ ok: false, error: "DOCKER_MISSING", check: "docker" });
  });

  test("a stopped daemon is DOCKER_NOT_RUNNING", async () => {
    const deps = fakeDeps({
      execMap: {
        "docker info --format {{json .}}": {
          code: 1,
          stdout: "",
          stderr: "Cannot connect to the Docker daemon",
          missing: false,
        },
      },
    });
    expect((await json(["doctor"], deps)).body.error).toBe("DOCKER_NOT_RUNNING");
  });

  test("DOCKER_NOT_RUNNING names `colima start` when Colima's default VM is stopped", async () => {
    const cases: Array<[string, string]> = [
      ["unix:///home/dana/.colima/default/docker.sock", "colima start"],
      ["unix:///home/dana/.colima/work/docker.sock", "Start Docker Desktop"],
      ["unix:///var/run/docker.sock", "Start Docker Desktop"],
    ];
    for (const [socket, fix] of cases) {
      const stderr = `failed to connect to the docker API at ${socket}; check if the path is correct and if the daemon is running`;
      const deps = fakeDeps({
        execMap: {
          "docker info --format {{json .}}": { code: 1, stdout: "", stderr, missing: false },
        },
      });
      expect((await json(["doctor"], deps)).body.fix).toContain(fix);
    }
  });

  test("a socket permission error is DOCKER_PERMISSION", async () => {
    const deps = fakeDeps({
      execMap: {
        "docker info --format {{json .}}": {
          code: 1,
          stdout: "",
          stderr: "permission denied while trying to connect to the docker API",
          missing: false,
        },
      },
    });
    expect((await json(["doctor"], deps)).body.error).toBe("DOCKER_PERMISSION");
  });

  test("Compose v1 is COMPOSE_MISSING", async () => {
    const deps = fakeDeps({ execMap: { "docker compose version --short": ok("1.29.2") } });
    expect((await json(["doctor"], deps)).body.error).toBe("COMPOSE_MISSING");
  });

  test("an architecture with no image is refused before anything installs", async () => {
    const deps = fakeDeps({
      execMap: {
        "docker info --format {{json .}}": ok(
          JSON.stringify({ Architecture: "riscv64", MemTotal: 8 * GB }),
        ),
      },
    });
    expect((await json(["doctor"], deps)).body.error).toBe("ARCH_UNSUPPORTED");
  });

  test("Apple Silicon (aarch64) and arm64 hosts pass", async () => {
    for (const arch of ["aarch64", "arm64"]) {
      const deps = fakeDeps({
        execMap: {
          "docker info --format {{json .}}": ok(
            JSON.stringify({ Architecture: arch, MemTotal: 8 * GB }),
          ),
        },
      });
      expect((await json(["doctor"], deps)).body.ok).toBe(true);
    }
  });

  test("a VM set to 2 GB, which Docker reports as about 1.9, passes", async () => {
    const deps = fakeDeps({
      execMap: {
        "docker info --format {{json .}}": ok(
          JSON.stringify({ Architecture: "aarch64", MemTotal: 1.9 * GB }),
        ),
      },
    });
    expect((await json(["doctor"], deps)).body.ok).toBe(true);
  });

  test("LOW_MEMORY names Colima's and Docker Desktop's own fix", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ Name: "colima" }, "colima stop && colima start --memory 4"],
      [{ OperatingSystem: "Docker Desktop" }, "Settings > Resources"],
      [{ Name: "colima-work" }, "Give Docker at least 2 GB"],
    ];
    for (const [extra, fix] of cases) {
      const deps = fakeDeps({
        execMap: {
          "docker info --format {{json .}}": ok(
            JSON.stringify({ Architecture: "aarch64", MemTotal: GB, ...extra }),
          ),
        },
      });
      const { body } = await json(["doctor"], deps);
      expect(body.error).toBe("LOW_MEMORY");
      expect(body.fix).toContain(fix);
    }
  });

  test("DOCKER_MISSING on a Mac names Docker Desktop, through Homebrew when it is there", async () => {
    const noDocker = { "docker --version": missing() };
    const brew = machine({ exec: noDocker, platform: "darwin", programs: ["brew"] });
    expect((await json(["doctor"], brew.deps)).body.fix).toContain("brew install --cask docker");
    const mac = machine({ exec: noDocker, platform: "darwin" });
    expect((await json(["doctor"], mac.deps)).body.fix).toContain("mac-install");
    const linux = machine({ exec: noDocker });
    expect((await json(["doctor"], linux.deps)).body.fix).toContain("docs.docker.com/get-docker");
  });

  test("a standalone docker-compose v2 passes when Docker has no Compose plugin", async () => {
    const deps = fakeDeps({
      execMap: {
        "docker compose version --short": fail("docker: 'compose' is not a docker command."),
        "docker-compose version --short": ok("2.29.1"),
      },
    });
    const { body } = await json(["doctor"], deps);
    expect(body.ok).toBe(true);
    expect(body.checks).toContainEqual({
      check: "compose",
      ok: true,
      detail: "2.29.1 (docker-compose)",
    });
  });

  test("a standalone docker-compose v1 is not Compose v2", async () => {
    const deps = fakeDeps({
      execMap: {
        "docker compose version --short": fail("docker: 'compose' is not a docker command."),
        "docker-compose version --short": ok("1.29.2"),
      },
    });
    expect((await json(["doctor"], deps)).body.error).toBe("COMPOSE_MISSING");
  });

  test("COMPOSE_MISSING on a Mac with Homebrew and no docker-compose installs it", async () => {
    const m = machine({
      exec: {
        "docker compose version --short": fail("docker: 'compose' is not a docker command."),
        "docker-compose version --short": missing(),
      },
      platform: "darwin",
      programs: ["brew"],
    });
    expect((await json(["doctor"], m.deps)).body.fix).toBe(
      "Install Compose with `brew install docker-compose`, then run this again.",
    );
  });

  test("under 2 GB of Docker memory is LOW_MEMORY", async () => {
    const deps = fakeDeps({
      execMap: {
        "docker info --format {{json .}}": ok(
          JSON.stringify({ Architecture: "x86_64", MemTotal: GB }),
        ),
      },
    });
    expect((await json(["doctor"], deps)).body.error).toBe("LOW_MEMORY");
  });

  test("a busy port is PORT_IN_USE, carrying the checks that passed", async () => {
    const { body } = await json(["doctor"], fakeDeps({ portFree: async () => false }));
    expect(body.error).toBe("PORT_IN_USE");
    expect(body.checks.filter((c: { ok: boolean }) => c.ok)).toHaveLength(5);
  });

  /** The install's own containers are running: `compose ps -q` lists them. */
  const running = { "docker compose ps -q": ok("4f1c2a9e\n") };

  test("the port held by this CLI's own running install passes, healthy or not", async () => {
    for (const phase of ["ready", "starting"] as const) {
      const deps = fakeDeps({
        execMap: running,
        portFree: async () => false,
        readText: async (p) =>
          p.endsWith("install.json") ? record({ phase }) : p.endsWith(".env") ? "" : undefined,
      });
      const { body } = await json(["doctor"], deps);
      expect(body.ok).toBe(true);
      expect(body.checks.at(-1)).toMatchObject({ check: "port", detail: "27246 (this install)" });
    }
  });

  test("a record from before 0.8.0, with no phase, is this install's and ready", async () => {
    const legacy = JSON.stringify({
      version: "0.78.0-beta.1",
      port: 27246,
      project: "nimblebrain-local-0a1b2c",
      agent: "claude-code",
    });
    const deps = fakeDeps({
      execMap: running,
      portFree: async () => false,
      readText: async (p) =>
        p.endsWith("install.json") ? legacy : p.endsWith(".env") ? "" : undefined,
    });
    const { body } = await json(["doctor"], deps);
    expect(body.ok).toBe(true);
    expect(body.checks.at(-1)).toMatchObject({ check: "port", detail: "27246 (this install)" });
  });

  test("a port held by something else is PORT_IN_USE, even with an install recorded", async () => {
    const deps = fakeDeps({
      portFree: async () => false,
      readText: async (p) => (p.endsWith("install.json") ? record() : undefined),
    });
    expect((await json(["doctor"], deps)).body.error).toBe("PORT_IN_USE");
  });

  test("an install on another port is checked on its own port, unless --port names one", async () => {
    const deps = fakeDeps({
      execMap: running,
      portFree: async () => false,
      readText: async (p) =>
        p.endsWith("install.json") ? record({ port: 27300 }) : p.endsWith(".env") ? "" : undefined,
    });
    const { body } = await json(["doctor"], deps);
    expect(body.ok).toBe(true);
    expect(body.checks.find((c: { check: string }) => c.check === "port").detail).toBe(
      "27300 (this install)",
    );
    expect((await json(["doctor", "--port", "27246"], deps)).body.error).toBe("PORT_IN_USE");
  });
});

describe("status", () => {
  const install = JSON.stringify({
    ...JSON.parse(record({ version: "0.70.0" })),
    agent: "claude-code",
  });

  test("no install is NOT_INSTALLED", async () => {
    expect((await json(["status"])).body.error).toBe("NOT_INSTALLED");
  });

  test("a running install names each workspace's MCP URL on the published port", async () => {
    const deps = fakeDeps({
      readText: async (p) =>
        p === "/home/dana/.nimblebrain-local/install.json" ? install : undefined,
      getJson: async (url) => {
        if (url.endsWith("/v1/health")) return { status: 200, body: { status: "ok" } };
        return {
          status: 200,
          body: {
            workspaces: [
              { id: "ws_8f3a", name: "Default", mcpUrl: "http://platform:27247/mcp/ws_8f3a" },
            ],
            config: { configuredProviders: [] },
          },
        };
      },
    });
    const { body } = await json(["status"], deps);
    expect(body).toMatchObject({
      ok: true,
      version: "0.70.0",
      health: "ok",
      url: "http://127.0.0.1:27246",
      workspaces: [{ id: "ws_8f3a", name: "Default", mcp: "http://127.0.0.1:27246/mcp/ws_8f3a" }],
      agent: { connected: "claude-code", skill: null },
      model_key: "missing",
    });
  });

  test("a stopped install reports down, not an error", async () => {
    const deps = fakeDeps({ readText: async () => install });
    const { body, code } = await json(["status"], deps);
    expect(code).toBe(0);
    expect(body).toMatchObject({ health: "down", workspaces: [], model_key: "missing" });
  });

  test("a corrupt or incomplete install.json is no install", async () => {
    for (const text of ["{", "null", "", JSON.stringify({ version: "0.70.0", port: 27246 })]) {
      const deps = fakeDeps({
        readText: async (p) => (p.endsWith("install.json") ? text : undefined),
      });
      expect((await json(["status"], deps)).body.error).toBe("NOT_INSTALLED");
    }
  });

  test("NIMBLEBRAIN_HOME moves the install", async () => {
    const seen: string[] = [];
    const deps = fakeDeps({
      // The update check's cache is not the install's, so it is off here.
      env: { NIMBLEBRAIN_HOME: "/srv/nb", NIMBLEBRAIN_NO_UPDATE_CHECK: "1" },
      readText: async (p) => {
        seen.push(p);
        return undefined;
      },
    });
    await json(["status"], deps);
    expect(seen).toContain("/srv/nb/install.json");
    expect(seen.every((p) => p.startsWith("/srv/nb/"))).toBe(true);
  });
});

describe("a run that ends without answering", () => {
  test("still answers once, as INTERRUPTED with the exit code, in the format asked for", () => {
    const asJson = interrupted(["init", "--json"], 143, machine().deps);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.stdout)).toMatchObject({
      ok: false,
      error: "INTERRUPTED",
      exit_code: 143,
    });
    const plain = interrupted(["init"], 130, machine().deps);
    expect(plain.stdout).toContain("exit code 130");
    expect(plain.stdout).toContain("fix: ");
  });
});

describe("the entry point", () => {
  const bin = join(import.meta.dir, "../src/bin.ts");

  test("a normal run answers once", async () => {
    const proc = Bun.spawn(["bun", bin, "--version", "--json"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(out)).toEqual({ ok: true, version: VERSION });
  });

  test("a signal mid-command answers once, as INTERRUPTED with 128 + n, and exits 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-bin-"));
    const started = join(dir, "started");
    const docker = join(dir, "docker");
    writeFileSync(docker, `#!/bin/sh\ntouch "${started}"\nexec sleep 30\n`);
    chmodSync(docker, 0o755);
    const proc = Bun.spawn(["bun", bin, "doctor", "--json"], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        NIMBLEBRAIN_HOME: join(dir, "home"),
        NIMBLEBRAIN_NO_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 100 && !existsSync(started); i++) await Bun.sleep(50);
    proc.kill("SIGTERM");
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: "INTERRUPTED", exit_code: 143 });
    expect(err).toContain("stopped before answering (exit code 143)");
  });
});

describe("writing a file", () => {
  test("replaces it whole, with its mode, and leaves nothing beside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-write-"));
    const path = join(dir, "install.json");
    writeFileSync(path, "old\n");
    await realDeps().writeText(path, "new\n", 0o600);
    expect(readFileSync(path, "utf8")).toBe("new\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["install.json"]);
  });

  test("a write that fails leaves the old file whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-write-"));
    const path = join(dir, "install.json");
    writeFileSync(path, "old\n");
    // The sibling it writes first cannot be a file, so the write fails before the rename.
    mkdirSync(`${path}.${process.pid}.tmp`);
    await expect(realDeps().writeText(path, "new\n")).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("old\n");
  });
});
