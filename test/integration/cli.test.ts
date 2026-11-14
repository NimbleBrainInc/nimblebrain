import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "bun";

// The runtime binary's one job is to serve. The deploy command is
// `bun run src/cli/index.ts serve` (Dockerfile CMD; `start` and `dev:api` also
// pass `serve`), and the entry strips that leading token. A parse-only assertion
// can't guard the strip — `serve <garbage>` exits non-zero with or without it.
// The only behavioral difference is whether a *bare* `serve` boots, so the boot
// smoke below is what actually pins the deploy contract.
const CLI = "src/cli/index.ts";

async function waitForHealth(port: number, opts: { timeoutMs: number }): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/v1/health`);
      if (res.ok) return true;
    } catch {
      // Port not listening yet — expected during boot.
    }
    await Bun.sleep(150);
  }
  return false;
}

describe("serve entry", () => {
  it("the deploy command (`serve`) boots and serves /v1/health", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nb-serve-"));
    writeFileSync(join(workDir, "instance.json"), JSON.stringify({ auth: { adapter: "dev" } }));
    const port = 27991;
    const proc = spawn(
      [
        "bun",
        "run",
        "--no-env-file",
        CLI,
        "serve",
        "--port",
        String(port),
        "--config",
        ".environments/empty/nimblebrain.json",
      ],
      {
        env: { ...process.env, NB_WORK_DIR: workDir, NB_TELEMETRY_DISABLED: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      expect(await waitForHealth(port, { timeoutMs: 20_000 })).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses to start without instance.json, naming what to write", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nb-serve-noauth-"));
    const proc = spawn(
      [
        "bun",
        "run",
        "--no-env-file",
        CLI,
        "serve",
        "--port",
        "27992",
        "--config",
        ".environments/empty/nimblebrain.json",
      ],
      {
        env: { ...process.env, NB_WORK_DIR: workDir, NB_TELEMETRY_DISABLED: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      expect(await proc.exited).toBe(1);
      const output =
        (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
      expect(output).toContain(
        `No identity provider: ${join(workDir, "instance.json")} does not exist`,
      );
      expect(output).toContain('{"auth":{"adapter":"dev"}}');
      expect(output).toContain('"adapter":"oidc"');
    } finally {
      proc.kill();
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an unrecognized positional as a usage error (exit 2)", () => {
    const result = spawnSync(["bun", "run", "--no-env-file", CLI, "fakecmd"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(2);
  });
});

// The dev provider admits every request, so `serve` must not hand it to the
// network unless told to. The image sets NB_HOST=0.0.0.0 for its own network.
describe("serve listen address", () => {
  async function serveOutput(
    port: number,
    opts: { env?: Record<string, string>; config?: object; portFlag?: false },
  ): Promise<string> {
    const workDir = mkdtempSync(join(tmpdir(), "nb-serve-host-"));
    writeFileSync(join(workDir, "instance.json"), JSON.stringify({ auth: { adapter: "dev" } }));
    const config = join(workDir, "nimblebrain.json");
    writeFileSync(config, JSON.stringify({ version: "1", ...opts.config }));
    const portArgs = opts.portFlag === false ? [] : ["--port", String(port)];
    const proc = spawn(
      ["bun", "run", "--no-env-file", CLI, "serve", ...portArgs, "--config", config],
      {
        env: {
          ...process.env,
          NB_HOST: "",
          PORT: "",
          ...opts.env,
          NB_WORK_DIR: workDir,
          NB_TELEMETRY_DISABLED: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      expect(await waitForHealth(port, { timeoutMs: 20_000 })).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(workDir, { recursive: true, force: true });
    }
    return (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  }

  it("listens on loopback by default", async () => {
    expect(await serveOutput(27993, {})).toContain("listening on 127.0.0.1:27993");
  }, 30_000);

  it("listens where NB_HOST says, over http.host", async () => {
    const env = { NB_HOST: "0.0.0.0" };
    const config = { http: { host: "127.0.0.1" } };
    expect(await serveOutput(27994, { env, config })).toContain("listening on 0.0.0.0:27994");
  }, 30_000);

  it("listens where http.host says", async () => {
    const config = { http: { host: "0.0.0.0" } };
    expect(await serveOutput(27995, { config })).toContain("listening on 0.0.0.0:27995");
  }, 30_000);

  it("brackets an IPv6 listen address", async () => {
    const env = { NB_HOST: "::" };
    expect(await serveOutput(27997, { env })).toContain("listening on [::]:27997");
  }, 30_000);

  it("listens on http.port when neither PORT nor --port is set", async () => {
    const config = { http: { port: 27996 } };
    expect(await serveOutput(27996, { config, portFlag: false })).toContain(
      "listening on 127.0.0.1:27996",
    );
  }, 30_000);
});
