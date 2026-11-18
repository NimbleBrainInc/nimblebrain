import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps, ExecResult } from "../src/deps.ts";
import { interrupted, run, VERSION } from "../src/main.ts";
import { GB, machine, ok } from "./fake.ts";

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

  test("the port held by this CLI's own running install passes", async () => {
    const deps = fakeDeps({
      portFree: async () => false,
      readText: async () =>
        JSON.stringify({ version: "0.70.0", port: 27246, project: "nimblebrain-local" }),
      getJson: async () => ({ status: 200, body: { status: "ok" } }),
    });
    expect((await json(["doctor"], deps)).body.ok).toBe(true);
  });
});

describe("status", () => {
  const install = JSON.stringify({
    version: "0.70.0",
    port: 27246,
    project: "nimblebrain-local",
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

  test("NIMBLEBRAIN_HOME moves the install", async () => {
    const seen: string[] = [];
    const deps = fakeDeps({
      env: { NIMBLEBRAIN_HOME: "/srv/nb" },
      readText: async (p) => {
        seen.push(p);
        return undefined;
      },
    });
    await json(["status"], deps);
    expect(seen).toEqual(["/srv/nb/install.json"]);
  });
});

describe("a run that ends without answering", () => {
  test("still answers once, as INTERRUPTED with the exit code, in the format asked for", () => {
    const asJson = interrupted(["init", "--json"], 143);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.stdout)).toMatchObject({
      ok: false,
      error: "INTERRUPTED",
      exit_code: 143,
    });
    const plain = interrupted(["init"], 130);
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
