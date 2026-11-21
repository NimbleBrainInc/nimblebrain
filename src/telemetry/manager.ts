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
  capture(params: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
    groups?: Record<string, string>;
  }): void;
  shutdown(): Promise<void>;
}

/**
 * Who an event is about, read from the verified request context. Present only
 * inside a request a person made; background work has none.
 */
export interface TelemetrySubject {
  userId: string;
  email?: string;
  name?: string;
  workspaceId?: string;
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
  /**
   * `telemetry.identify`: events name the person and the workspace instead of
   * the install. Honored only alongside `enabled: true`, because it is an
   * operator's decision about its own project, never a person's answer.
   */
  identify?: boolean;
  clientFactory?: TelemetryClientFactory;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export class TelemetryManager {
  private client: TelemetryClient | null = null;
  private subjectSource: () => TelemetrySubject | undefined = () => undefined;
  /** People whose email and name this process has already set, so each is sent once. */
  private readonly described = new Set<string>();

  private constructor(
    private readonly workDir: string,
    private readonly apiKey: string,
    private readonly factory: TelemetryClientFactory,
    private readonly anonymousId: string,
    private consent: TelemetryConsent,
    private readonly locked: TelemetryLock | undefined,
    private readonly identified = false,
    private readonly tenantId?: string,
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
      return new TelemetryManager(
        options.workDir,
        apiKey,
        factory,
        id,
        "on",
        "operator",
        options.identify === true,
        env.NB_TENANT_ID?.trim() || undefined,
      );
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
    if (!this.identified) {
      this.client.capture({
        distinctId: this.anonymousId,
        event,
        properties: { ...commonProperties(), ...properties },
      });
      return;
    }
    // Identified: the person who made the request, in their tenant and
    // workspace. Work no person asked for stays with the install.
    const subject = this.subjectSource();
    const groups: Record<string, string> = {};
    if (this.tenantId) groups.tenant = this.tenantId;
    if (subject?.workspaceId) groups.workspace = subject.workspaceId;
    const person = subject ? this.describe(subject) : {};
    this.client.capture({
      distinctId: subject?.userId ?? this.anonymousId,
      event,
      properties: { ...commonProperties(), ...properties, ...person },
      ...(Object.keys(groups).length > 0 ? { groups } : {}),
    });
  }

  /**
   * Where identified events find their person: the runtime registers its
   * request context here. Unused unless the deployment set `telemetry.identify`.
   */
  setSubjectSource(source: () => TelemetrySubject | undefined): void {
    this.subjectSource = source;
  }

  /** The signed-in person of the current request, on an identified deployment. */
  currentUserId(): string | undefined {
    return this.identified ? this.subjectSource()?.userId : undefined;
  }

  /** Whether events name the person (`telemetry.identify` with `enabled: true`). */
  isIdentified(): boolean {
    return this.identified;
  }

  /** The tenant identified events are grouped under, from `NB_TENANT_ID`. */
  getTenantId(): string | undefined {
    return this.identified ? this.tenantId : undefined;
  }

  /** The person's email and name as `$set`, the first time this process sees them. */
  private describe(subject: TelemetrySubject): Record<string, unknown> {
    if (this.described.has(subject.userId)) return {};
    this.described.add(subject.userId);
    const set: Record<string, string> = {};
    if (subject.email) set.email = subject.email;
    if (subject.name) set.name = subject.name;
    return Object.keys(set).length > 0 ? { $set: set } : {};
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
