import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const TELEMETRY_ID_FILE = ".telemetry-id";
/** The person's answer, `{"consent": "on" | "off"}`, kept beside the install's data. */
const CONSENT_FILE = "telemetry.json";
const POSTHOG_HOST = "https://us.i.posthog.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dirname ?? __dirname, "../../package.json"), "utf-8"),
) as { version: string };

/**
 * Whether this install sends anonymous telemetry. Nothing is sent until a
 * person answers: `undecided` sends nothing, and so does `off`.
 */
export type TelemetryConsent = "on" | "off" | "undecided";

/**
 * Why the answer cannot be changed here. `operator`: the deployment decided
 * (`DO_NOT_TRACK`, `NB_TELEMETRY_DISABLED`, or `telemetry.enabled` in the
 * config). `no_destination`: no PostHog key is configured, so there is nothing
 * to agree to and no one is asked.
 */
export type TelemetryLock = "operator" | "no_destination";

export interface TelemetryStatus {
  consent: TelemetryConsent;
  /** Present when no person can change the answer. */
  locked?: TelemetryLock;
}

/** Raised when a person tries to change an answer the deployment owns. */
export class TelemetryLockedError extends Error {
  readonly lock: TelemetryLock;
  constructor(lock: TelemetryLock) {
    super(
      lock === "operator"
        ? "Telemetry is set by this deployment's configuration and cannot be changed here."
        : "This install has nowhere to send telemetry, so there is nothing to turn on.",
    );
    this.name = "TelemetryLockedError";
    this.lock = lock;
  }
}

/** Minimal interface for PostHog client (production or mock). */
export interface TelemetryClient {
  capture(params: { distinctId: string; event: string; properties: Record<string, unknown> }): void;
  shutdown(): Promise<void>;
}

export type TelemetryClientFactory = (
  apiKey: string,
  options: {
    host: string;
    flushAt: number;
    flushInterval: number;
    disableGeoip: boolean;
  },
) => TelemetryClient;

export interface TelemetryManagerOptions {
  workDir: string;
  /**
   * The deployment's decision from `telemetry.enabled`. `false` turns telemetry
   * off and `true` turns it on, both without asking anyone; absent leaves the
   * answer to a person.
   */
  enabled?: boolean;
  clientFactory?: TelemetryClientFactory;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export class TelemetryManager {
  private client: TelemetryClient | null = null;

  private constructor(
    private readonly workDir: string,
    private readonly apiKey: string,
    private readonly factory: TelemetryClientFactory,
    private readonly anonymousId: string,
    private consent: TelemetryConsent,
    private readonly locked: TelemetryLock | undefined,
  ) {
    if (consent === "on") this.client = this.connect();
  }

  static create(options: TelemetryManagerOptions): TelemetryManager {
    const env = options.env ?? process.env;
    const factory = options.clientFactory ?? defaultClientFactory;
    const apiKey = env.POSTHOG_API_KEY ?? "";

    // The operator's off wins over everything, and leaves nothing on disk.
    if (env.NB_TELEMETRY_DISABLED === "1" || env.DO_NOT_TRACK === "1" || options.enabled === false)
      return new TelemetryManager(options.workDir, apiKey, factory, "", "off", "operator");
    // A test passes a factory in place of a key.
    if (!apiKey && !options.clientFactory)
      return new TelemetryManager(options.workDir, apiKey, factory, "", "off", "no_destination");

    const id = installId(options.workDir, env);
    if (options.enabled === true)
      return new TelemetryManager(options.workDir, apiKey, factory, id, "on", "operator");
    return new TelemetryManager(
      options.workDir,
      apiKey,
      factory,
      id,
      readConsent(options.workDir, env),
      undefined,
    );
  }

  capture(event: string, properties: Record<string, unknown> = {}): void {
    if (this.consent !== "on" || !this.client) return;
    this.client.capture({
      distinctId: this.anonymousId,
      event,
      properties: { ...commonProperties(), ...properties },
    });
  }

  /** Records a person's answer and applies it at once. Throws `TelemetryLockedError` when the deployment owns it. */
  setConsent(consent: "on" | "off"): TelemetryStatus {
    if (this.locked) throw new TelemetryLockedError(this.locked);
    mkdirSync(this.workDir, { recursive: true });
    const path = join(this.workDir, CONSENT_FILE);
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ consent })}\n`);
    renameSync(`${path}.tmp`, path);
    this.consent = consent;
    if (consent === "on" && !this.client) this.client = this.connect();
    return this.status();
  }

  status(): TelemetryStatus {
    return this.locked ? { consent: this.consent, locked: this.locked } : { consent: this.consent };
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown();
  }

  /** Whether events are being sent now. */
  isEnabled(): boolean {
    return this.consent === "on" && this.client !== null;
  }

  /** The install's anonymous id; empty when telemetry can never be on. */
  getAnonymousId(): string {
    return this.anonymousId;
  }

  static resetId(workDir: string): string {
    const idPath = join(workDir, TELEMETRY_ID_FILE);
    if (existsSync(idPath)) unlinkSync(idPath);
    const newId = randomUUID();
    mkdirSync(workDir, { recursive: true });
    writeFileSync(idPath, `${newId}\n`);
    return newId;
  }

  private connect(): TelemetryClient {
    // Batched flush: the runtime is a long-running server, so events accumulate
    // and flush every 30s (or every 20 events).
    return this.factory(this.apiKey, {
      host: POSTHOG_HOST,
      flushAt: 20,
      flushInterval: 30_000,
      disableGeoip: true,
    });
  }
}

/**
 * The install's anonymous id. `NB_TELEMETRY_ID` (a UUID) wins, so an installer
 * that sends its own events before the runtime starts (the `nimblebrain` CLI)
 * and the runtime report as one install. Otherwise a random UUID kept in the
 * work directory.
 */
function installId(workDir: string, env: NodeJS.ProcessEnv): string {
  const given = env.NB_TELEMETRY_ID?.trim();
  if (given && UUID.test(given)) return given.toLowerCase();
  mkdirSync(workDir, { recursive: true });
  const idPath = join(workDir, TELEMETRY_ID_FILE);
  if (existsSync(idPath)) return readFileSync(idPath, "utf-8").trim();
  const id = randomUUID();
  writeFileSync(idPath, `${id}\n`);
  return id;
}

/**
 * The recorded answer. `NB_TELEMETRY_CONSENT` carries an answer an installer
 * took before the runtime first ran (the `nimblebrain` CLI asks at `init`);
 * once a person answers here, the recorded file wins. Anything unreadable
 * counts as no answer.
 */
function readConsent(workDir: string, env: NodeJS.ProcessEnv): TelemetryConsent {
  try {
    const { consent } = JSON.parse(readFileSync(join(workDir, CONSENT_FILE), "utf-8")) as {
      consent?: unknown;
    };
    if (consent === "on" || consent === "off") return consent;
  } catch {
    // No answer recorded here yet.
  }
  const seed = env.NB_TELEMETRY_CONSENT;
  return seed === "on" || seed === "off" ? seed : "undecided";
}

/** Common properties enriched on every captured event. */
function commonProperties(): Record<string, unknown> {
  return {
    nb_version: process.env.NB_VERSION || pkg.version,
    os: process.platform,
    arch: process.arch,
    bun_version: typeof Bun !== "undefined" ? Bun.version : "unknown",
  };
}

/** Default factory using the real posthog-node SDK. */
function defaultClientFactory(
  apiKey: string,
  options: {
    host: string;
    flushAt: number;
    flushInterval: number;
    disableGeoip: boolean;
  },
): TelemetryClient {
  // Lazy import to avoid loading posthog-node when telemetry is off
  const { PostHog } = require("posthog-node");
  const client = new PostHog(apiKey, {
    host: options.host,
    flushAt: options.flushAt,
    flushInterval: options.flushInterval,
    disableGeoip: options.disableGeoip,
  });
  return {
    capture: (params) => client.capture(params),
    shutdown: () => client.shutdown(),
  };
}
