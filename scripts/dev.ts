#!/usr/bin/env bun
/**
 * `bun run dev` — supervised dual-process development mode.
 *
 * Local developer tooling, not part of the runtime. Spawns the API server in
 * watch mode (`bun --watch src/cli/index.ts serve`) plus the Vite web dev
 * server, with unified prefixed output and readiness gating. The runtime binary
 * (`src/cli/index.ts`) only serves; this script orchestrates the dev loop on top
 * of it, alongside the other `scripts/dev-*.ts` tooling.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Subprocess, spawn } from "bun";
import { log } from "../src/observability/log.ts";
import { setAppDevMode } from "../src/runtime/dev-registry.ts";

interface DevOptions {
  port: number;
  noWeb: boolean;
  config: string | undefined;
  debug: boolean;
  app?: string;
  appPort?: number;
}

/**
 * Prefix each line from a ReadableStream and write to an output stream.
 * Handles partial lines (no trailing newline) gracefully.
 */
async function prefixLines(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  output: NodeJS.WriteStream,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last element — it's either "" (line ended with \n) or a partial line
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.length > 0) {
          output.write(`${prefix} ${line}\n`);
        }
      }
    }

    // Flush remaining buffer
    if (buffer.length > 0) {
      output.write(`${prefix} ${buffer}\n`);
    }
  } catch {
    // Stream closed — normal during shutdown
  }
}

/**
 * Poll the API's /v1/health endpoint until it responds OK or the deadline elapses.
 * Used to gate Vite dev server spawns on API readiness so they don't fire requests
 * into a not-yet-listening port (which produces noisy ECONNREFUSED stack traces).
 */
async function waitForHealth(port: number, opts: { timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  const url = `http://localhost:${port}/v1/health`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Port not bound yet — expected during startup.
    }
    await Bun.sleep(100);
  }

  throw new Error(`API did not become ready within ${opts.timeoutMs}ms`);
}

/** Build the `bun --watch` API-server argv from the dev options. */
function buildApiArgs(
  cliEntry: string,
  port: number,
  config: string | undefined,
  debug: boolean,
): string[] {
  const apiArgs = ["bun", "--watch", cliEntry, "serve", "--port", String(port)];
  // Only pass --config if explicitly provided — otherwise let serve use defaults
  if (config) {
    apiArgs.push("--config", resolve(config));
  }
  if (debug) apiArgs.push("--debug");
  return apiArgs;
}

/** Build the dev-mode env, auto-filling NB_WEB_URL for the post-OAuth SPA bounce. */
function buildDevEnv(noWeb: boolean): Record<string, string | undefined> {
  // Auto-derive NB_WEB_URL so the API knows where to bounce the user
  // back after an OAuth callback. Without this, the callback can only
  // redirect to NB_API_URL (the API port), which doesn't serve the SPA
  // in dev — the user lands on a workspace_error JSON page instead of
  // the Connections tab.
  //
  // Mirrors web/vite.config.ts: NB_WEB_PORT env if set, else default 27246.
  // Operator-supplied NB_WEB_URL wins (the auto-derivation only fills
  // in the unset case).
  const devEnv: Record<string, string | undefined> = { ...process.env };
  if (!devEnv.NB_WEB_URL && !noWeb) {
    const webPort = process.env.NB_WEB_PORT ?? "27246";
    devEnv.NB_WEB_URL = `http://localhost:${webPort}`;
  }
  return devEnv;
}

/** Track a child for shutdown and stream its stdout/stderr under a log prefix. */
function pipeChild(children: Subprocess[], proc: Subprocess, prefix: string): void {
  children.push(proc);
  prefixLines(proc.stdout as ReadableStream<Uint8Array>, prefix, process.stdout);
  prefixLines(proc.stderr as ReadableStream<Uint8Array>, prefix, process.stderr);
}

/** Gate on API readiness; on timeout, SIGTERM the API child and exit the process. */
async function waitForApiReadyOrExit(apiProc: Subprocess, port: number): Promise<void> {
  // Gate Vite spawns on API readiness. Without this, Vite proxies fire requests
  // into a not-yet-listening API and the user sees ECONNREFUSED stack traces
  // until bundles finish loading.
  log.info("[dev] Waiting for API to become ready...");
  try {
    await waitForHealth(port, { timeoutMs: 30_000 });
    log.info("[dev] API ready");
  } catch {
    log.info("[dev] API failed to become ready within 30s. Exiting.");
    try {
      apiProc.kill("SIGTERM");
    } catch {
      // Already dead
    }
    process.exit(1);
  }
}

/** Start the Vite web dev server unless disabled or missing, tracking it under [web]. */
function startWebServer(noWeb: boolean, children: Subprocess[]): Subprocess | undefined {
  if (noWeb) return undefined;

  const webDir = join(process.cwd(), "web");
  if (!existsSync(join(webDir, "package.json"))) {
    log.info("[dev] Warning: web/package.json not found. Skipping web dev server.");
    return undefined;
  }

  log.info("[dev] Starting web dev server...");
  const webProc = spawn({
    cmd: ["bun", "run", "dev"],
    cwd: webDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  pipeChild(children, webProc, "[web]");
  return webProc;
}

/** Start the app's Vite dev server for --app, registering dev mode and tracking it under [app]. */
function startAppServer(
  appPath: string | undefined,
  appPort: number,
  children: Subprocess[],
): void {
  if (!appPath) return;

  const resolvedAppPath = resolve(appPath);
  const manifestPath = join(resolvedAppPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    log.info(`[dev] Warning: ${manifestPath} not found. Skipping app dev server.`);
    return;
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const appNameFromManifest = manifest.name ?? "unknown-app";
    const devUrl = `http://localhost:${appPort}`;

    setAppDevMode(appNameFromManifest, devUrl);
    log.info(`[dev] Starting app dev server for ${appNameFromManifest} on port ${appPort}...`);

    const appProc = spawn({
      cmd: ["npx", "vite", "--port", String(appPort)],
      cwd: resolvedAppPath,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    pipeChild(children, appProc, "[app]");
  } catch (err) {
    log.info(`[dev] Failed to read app manifest: ${err}`);
  }
}

/** Send a signal to every tracked child, ignoring already-dead ones. */
function signalChildren(children: Subprocess[], signal: "SIGTERM" | "SIGKILL"): void {
  for (const child of children) {
    try {
      child.kill(signal);
    } catch {
      // Already dead
    }
  }
}

/**
 * Install SIGINT/SIGTERM handlers that SIGTERM all children (SIGKILL after 5s);
 * returns a reader for the shutting-down flag.
 */
function installShutdown(children: Subprocess[]): () => boolean {
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      // Second signal — force exit
      process.exit(1);
    }
    shuttingDown = true;
    log.info("\n[dev] Shutting down...");

    signalChildren(children, "SIGTERM");

    // Force kill after 5s
    setTimeout(() => {
      signalChildren(children, "SIGKILL");
      process.exit(1);
    }, 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return () => shuttingDown;
}

async function runDev(options: DevOptions): Promise<void> {
  const { port, noWeb, config, debug, app: appPath, appPort = 5173 } = options;
  const children: Subprocess[] = [];

  // The runtime entry, relative to this script (scripts/ -> ../src/cli/index.ts).
  const cliEntry = join(import.meta.dir, "..", "src", "cli", "index.ts");

  // --- API server with bun --watch ---
  const apiArgs = buildApiArgs(cliEntry, port, config, debug);
  const devEnv = buildDevEnv(noWeb);

  log.info("[dev] Starting API server with file watching...");
  const apiProc = spawn({
    cmd: apiArgs,
    stdout: "pipe",
    stderr: "pipe",
    env: devEnv,
  });
  pipeChild(children, apiProc, "[api]");

  await waitForApiReadyOrExit(apiProc, port);

  // --- Web dev server (unless --no-web) ---
  const webProc = startWebServer(noWeb, children);

  // --- App dev server (when --app is specified) ---
  startAppServer(appPath, appPort, children);

  // --- Shutdown handling ---
  const isShuttingDown = installShutdown(children);

  // Wait for API process to exit (bun --watch keeps it alive)
  const apiExitCode = await apiProc.exited;

  if (!isShuttingDown()) {
    log.info(`[dev] API server exited with code ${apiExitCode}`);

    // Clean up web process if still running
    if (webProc) {
      try {
        webProc.kill("SIGTERM");
      } catch {
        // Already dead
      }
    }
  }

  process.exit(apiExitCode ?? 0);
}

async function main(): Promise<void> {
  const rest = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    // strict:false so the `--no-web` negation token passes through; we read it
    // off argv directly since parseArgs has no boolean-negation support.
    strict: false,
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string" },
      app: { type: "string" },
      "app-port": { type: "string" },
      debug: { type: "boolean" },
    },
  });
  await runDev({
    port: values.port ? Number(values.port) : 27247,
    noWeb: rest.includes("--no-web"),
    config: values.config as string | undefined,
    debug: (values.debug as boolean | undefined) ?? false,
    app: values.app as string | undefined,
    appPort: values["app-port"] ? Number(values["app-port"]) : undefined,
  });
}

main().catch((err) => {
  log.error(`[dev] Fatal: ${err}`);
  process.exit(1);
});
