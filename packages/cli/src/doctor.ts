import type { Deps } from "./deps.ts";
import { CliError, type ErrorCode } from "./result.ts";

/**
 * The CPU architectures the runtime publishes images for, as Docker reports
 * them (`docker info` says `x86_64` or `aarch64`; some hosts say `amd64` or
 * `arm64`). Releases from v0.73.0 publish `linux/amd64` and `linux/arm64`, and
 * the CLI installs nothing older (`MIN_RUNTIME`).
 */
export const SUPPORTED_ARCH = ["x86_64", "amd64", "aarch64", "arm64"];

/** The runtime's working floor, in bytes of memory Docker can give it. */
export const MIN_MEMORY = 2 * 1024 ** 3;

export interface Check {
  check: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  ok: true;
  checks: Check[];
  arch: string;
}

/**
 * Checks the machine in the order a person would fix it: Docker installed,
 * running and usable, Compose v2, an architecture with images, enough memory,
 * a free port. Stops at the first failure and throws its code, carrying the
 * checks that passed, so the fix named is always the next thing to do.
 *
 * `portInUseByUs` skips the port check when the install on that port is this
 * CLI's own and running: on a rerun the port being taken is the good case.
 */
export async function doctor(
  deps: Deps,
  port: number,
  portInUseByUs = false,
): Promise<DoctorResult> {
  const log = recorder();
  await checkDocker(deps, log);
  const facts = await checkDaemon(deps, log);
  await checkCompose(deps, log);
  checkArch(facts.arch, log);
  checkMemory(facts.memory, log);
  await checkPort(deps, port, portInUseByUs, log);
  return { ok: true, checks: log.checks, arch: facts.arch };
}

interface Recorder {
  checks: Check[];
  pass(check: string, detail: string): void;
  fail(check: string, code: ErrorCode, detail: string): never;
}

function recorder(): Recorder {
  const checks: Check[] = [];
  return {
    checks,
    pass: (check, detail) => {
      checks.push({ check, ok: true, detail });
    },
    fail: (check, code, detail) => {
      checks.push({ check, ok: false, detail });
      throw new CliError(code, detail, { check, checks });
    },
  };
}

async function checkDocker(deps: Deps, log: Recorder): Promise<void> {
  const version = await deps.exec("docker", ["--version"]);
  if (version.missing) log.fail("docker", "DOCKER_MISSING", "Docker is not installed.");
  log.pass("docker", version.stdout.trim());
}

async function checkDaemon(deps: Deps, log: Recorder): Promise<{ arch: string; memory: number }> {
  const info = await deps.exec("docker", ["info", "--format", "{{json .}}"]);
  if (info.code !== 0) {
    if (/permission denied/i.test(`${info.stderr}\n${info.stdout}`)) {
      log.fail("docker-daemon", "DOCKER_PERMISSION", "This user may not use Docker.");
    }
    log.fail("docker-daemon", "DOCKER_NOT_RUNNING", "Docker is installed but not running.");
  }
  log.pass("docker-daemon", "running");
  return parseInfo(info.stdout);
}

async function checkCompose(deps: Deps, log: Recorder): Promise<void> {
  const compose = await deps.exec("docker", ["compose", "version", "--short"]);
  const major = Number.parseInt(compose.stdout.trim().replace(/^v/, ""), 10);
  if (compose.code !== 0 || !(major >= 2)) {
    log.fail("compose", "COMPOSE_MISSING", "Docker Compose v2 is not available.");
  }
  log.pass("compose", compose.stdout.trim());
}

function checkArch(arch: string, log: Recorder): void {
  if (!SUPPORTED_ARCH.includes(arch)) {
    log.fail(
      "arch",
      "ARCH_UNSUPPORTED",
      `No NimbleBrain image is published for ${arch || "this architecture"}.`,
    );
  }
  log.pass("arch", arch);
}

function checkMemory(memory: number, log: Recorder): void {
  if (memory > 0 && memory < MIN_MEMORY) {
    log.fail(
      "memory",
      "LOW_MEMORY",
      `Docker has ${gib(memory)} of memory; NimbleBrain needs 2 GB.`,
    );
  }
  log.pass("memory", memory > 0 ? gib(memory) : "unknown");
}

async function checkPort(deps: Deps, port: number, ours: boolean, log: Recorder): Promise<void> {
  if (ours) return log.pass("port", `${port} (this install)`);
  if (!(await deps.portFree(port))) log.fail("port", "PORT_IN_USE", `Port ${port} is in use.`);
  log.pass("port", String(port));
}

function parseInfo(stdout: string): { arch: string; memory: number } {
  try {
    const info = JSON.parse(stdout) as { Architecture?: unknown; MemTotal?: unknown };
    return {
      arch: typeof info.Architecture === "string" ? info.Architecture : "",
      memory: typeof info.MemTotal === "number" ? info.MemTotal : 0,
    };
  } catch {
    return { arch: "", memory: 0 };
  }
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
