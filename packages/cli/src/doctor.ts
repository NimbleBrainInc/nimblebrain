import { daemonVariant, findCompose } from "./compose.ts";
import type { Deps } from "./deps.ts";
import { heldByText, movePort, type PortMove } from "./ports.ts";
import { CliError, type ErrorCode, type FixVariant } from "./result.ts";

/**
 * The CPU architectures the runtime publishes images for, as Docker reports
 * them (`docker info` says `x86_64` or `aarch64`; some hosts say `amd64` or
 * `arm64`). Releases from v0.73.0 publish `linux/amd64` and `linux/arm64`, and
 * the CLI installs nothing older (`MIN_RUNTIME`).
 */
export const SUPPORTED_ARCH = ["x86_64", "amd64", "aarch64", "arm64"];

/**
 * The least memory Docker may report, in bytes. The runtime needs 2 GB, but
 * Docker reports its VM's memory less what the VM's kernel keeps, so a VM set
 * to 2 GB (Docker Desktop, Colima) reports about 1.9 GB. The floor sits below
 * that, so following `LOW_MEMORY`'s fix passes.
 */
export const MIN_MEMORY = 1.75 * 1024 ** 3;

export interface Check {
  check: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  ok: true;
  checks: Check[];
  arch: string;
  /** The port a new install takes instead of a busy default, when `movableFor` allowed a move. */
  port_moved?: PortMove;
}

/**
 * Checks the machine in the order a person would fix it: Docker installed,
 * running and usable, Compose v2, an architecture with images, enough memory,
 * a free port. Stops at the first failure and throws its code, carrying the
 * checks that passed, so the fix named is always the next thing to do.
 *
 * `portInUseByUs` skips the port check when the install on that port is this
 * CLI's own and running: on a rerun the port being taken is the good case.
 * `movableFor`, the home of a new install that named no port, lets a busy
 * default move to the next free port (`movePort`) instead of failing; the
 * check passes on that port and the answer carries `port_moved`.
 */
export async function doctor(
  deps: Deps,
  port: number,
  portInUseByUs = false,
  movableFor?: string,
): Promise<DoctorResult> {
  const log = recorder();
  await checkDocker(deps, log);
  const facts = await checkDaemon(deps, log);
  await checkCompose(deps, log);
  checkArch(facts.arch, log);
  checkMemory(facts, log);
  const moved = await checkPort(deps, port, portInUseByUs, movableFor, log);
  return {
    ok: true,
    checks: log.checks,
    arch: facts.arch,
    ...(moved ? { port_moved: moved } : {}),
  };
}

interface Recorder {
  checks: Check[];
  pass(check: string, detail: string): void;
  fail(check: string, code: ErrorCode, detail: string, variant?: FixVariant): never;
}

function recorder(): Recorder {
  const checks: Check[] = [];
  return {
    checks,
    pass: (check, detail) => {
      checks.push({ check, ok: true, detail });
    },
    fail: (check, code, detail, variant) => {
      checks.push({ check, ok: false, detail });
      throw new CliError(code, detail, { check, checks }, variant);
    },
  };
}

async function checkDocker(deps: Deps, log: Recorder): Promise<void> {
  const version = await deps.exec("docker", ["--version"]);
  if (version.missing) {
    const variant =
      deps.platform !== "darwin" ? undefined : (await deps.which("brew")) ? "mac_brew" : "mac";
    log.fail("docker", "DOCKER_MISSING", "Docker is not installed.", variant);
  }
  log.pass("docker", version.stdout.trim());
}

interface DaemonFacts {
  arch: string;
  memory: number;
  /** Which Docker this is, when its fix differs: `docker info`'s `OperatingSystem` and `Name`. */
  kind?: "docker_desktop" | "colima";
}

async function checkDaemon(deps: Deps, log: Recorder): Promise<DaemonFacts> {
  const info = await deps.exec("docker", ["info", "--format", "{{json .}}"]);
  if (info.code !== 0) {
    if (/permission denied/i.test(`${info.stderr}\n${info.stdout}`)) {
      log.fail("docker-daemon", "DOCKER_PERMISSION", "This user may not use Docker.");
    }
    log.fail(
      "docker-daemon",
      "DOCKER_NOT_RUNNING",
      "Docker is installed but not running.",
      daemonVariant(info.stderr),
    );
  }
  log.pass("docker-daemon", "running");
  return parseInfo(info.stdout);
}

/** Compose v2, as Docker's plugin or the standalone `docker-compose` (`findCompose`). */
async function checkCompose(deps: Deps, log: Recorder): Promise<void> {
  const program = await findCompose(deps);
  if (!program) {
    const variant = deps.platform === "darwin" && (await deps.which("brew")) ? "brew" : undefined;
    log.fail("compose", "COMPOSE_MISSING", "Docker Compose v2 is not available.", variant);
  }
  log.pass(
    "compose",
    program.cmd === "docker" ? program.version : `${program.version} (${program.cmd})`,
  );
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

function checkMemory({ memory, kind }: DaemonFacts, log: Recorder): void {
  if (memory > 0 && memory < MIN_MEMORY) {
    log.fail(
      "memory",
      "LOW_MEMORY",
      `Docker has ${gib(memory)} of memory; NimbleBrain needs 2 GB.`,
      kind,
    );
  }
  log.pass("memory", memory > 0 ? gib(memory) : "unknown");
}

async function checkPort(
  deps: Deps,
  port: number,
  ours: boolean,
  movableFor: string | undefined,
  log: Recorder,
): Promise<PortMove | undefined> {
  if (ours) {
    log.pass("port", `${port} (this install)`);
    return undefined;
  }
  if (movableFor === undefined) {
    if (!(await deps.portFree(port))) log.fail("port", "PORT_IN_USE", `Port ${port} is in use.`);
    log.pass("port", String(port));
    return undefined;
  }
  let moved: PortMove | undefined;
  try {
    moved = await movePort(deps, movableFor, port, "web");
  } catch (err) {
    if (err instanceof CliError) log.fail("port", err.code, err.message);
    throw err;
  }
  log.pass(
    "port",
    moved ? `${moved.to} (${port} is in use by ${heldByText(deps, moved)})` : String(port),
  );
  return moved;
}

function parseInfo(stdout: string): DaemonFacts {
  try {
    const info = JSON.parse(stdout) as {
      Architecture?: unknown;
      MemTotal?: unknown;
      OperatingSystem?: unknown;
      Name?: unknown;
    };
    return {
      arch: typeof info.Architecture === "string" ? info.Architecture : "",
      memory: typeof info.MemTotal === "number" ? info.MemTotal : 0,
      // Colima's default VM is named `colima`; another profile's fix names its profile, so it gets the general one.
      kind:
        info.OperatingSystem === "Docker Desktop"
          ? "docker_desktop"
          : info.Name === "colima"
            ? "colima"
            : undefined,
    };
  } catch {
    return { arch: "", memory: 0 };
  }
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
