import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Subprocess, spawn } from "bun";
import { setAppDevMode } from "../runtime/dev-registry.ts";
import { log } from "./log.ts";

export interface DevOptions {
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
 * `nb dev` — supervised dual-process development mode.
 *
 * Starts the API server with bun --watch (auto-restart on source changes)
 * and optionally the Vite web dev server. Both share a single terminal
 * with prefixed output.
 */
export async function runDev(options: DevOptions): Promise<void> {
  const { port, noWeb, config, debug, app: appPath, appPort = 5173 } = options;
  const children: Subprocess[] = [];

  // Resolve the CLI entry point relative to this file's location
  const cliEntry = join(import.meta.dir, "index.ts");

  // --- API server with bun --watch ---
  const apiArgs = ["bun", "--watch", cliEntry, "serve", "--port", String(port)];
  // Only pass --config if explicitly provided — otherwise let serve use defaults
  if (config) {
    apiArgs.push("--config", resolve(config));
  }
  if (debug) apiArgs.push("--debug");

  log.info("[dev] Starting API server with file watching...");
  const apiProc = spawn({
    cmd: apiArgs,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  children.push(apiProc);

  // Pipe API output with [api] prefix
  prefixLines(apiProc.stdout as ReadableStream<Uint8Array>, "[api]", process.stdout);
  prefixLines(apiProc.stderr as ReadableStream<Uint8Array>, "[api]", process.stderr);

  // --- Web dev server (unless --no-web) ---
  let webProc: Subprocess | undefined;
  const webDir = join(process.cwd(), "web");

  if (!noWeb) {
    if (!existsSync(join(webDir, "package.json"))) {
      log.info("[dev] Warning: web/package.json not found. Skipping web dev server.");
    } else {
      log.info("[dev] Starting web dev server...");
      webProc = spawn({
        cmd: ["bun", "run", "dev"],
        cwd: webDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      children.push(webProc);

      prefixLines(webProc.stdout as ReadableStream<Uint8Array>, "[web]", process.stdout);
      prefixLines(webProc.stderr as ReadableStream<Uint8Array>, "[web]", process.stderr);
    }
  }

  // --- App dev server (when --app is specified) ---
  if (appPath) {
    const resolvedAppPath = resolve(appPath);
    const manifestPath = join(resolvedAppPath, "manifest.json");

    if (!existsSync(manifestPath)) {
      log.info(`[dev] Warning: ${manifestPath} not found. Skipping app dev server.`);
    } else {
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
        children.push(appProc);

        prefixLines(appProc.stdout as ReadableStream<Uint8Array>, "[app]", process.stdout);
        prefixLines(appProc.stderr as ReadableStream<Uint8Array>, "[app]", process.stderr);
      } catch (err) {
        log.info(`[dev] Failed to read app manifest: ${err}`);
      }
    }
  }

  // --- Shutdown handling ---
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      // Second signal — force exit
      process.exit(1);
    }
    shuttingDown = true;
    log.info("\n[dev] Shutting down...");

    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already dead
      }
    }

    // Force kill after 5s
    setTimeout(() => {
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead
        }
      }
      process.exit(1);
    }, 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Wait for API process to exit (bun --watch keeps it alive)
  const apiExitCode = await apiProc.exited;

  if (!shuttingDown) {
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
