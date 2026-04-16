import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TELEMETRY_ID_FILE = ".telemetry-id";

// Write-only PostHog project API key. Set POSTHOG_API_KEY env var to override.
// If unset, telemetry is silently disabled.
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY ?? "";
const POSTHOG_HOST = "https://us.i.posthog.com";

const FIRST_RUN_NOTICE = `
NimbleBrain collects anonymous usage telemetry to improve the platform.
No personal data, conversation content, or file paths are ever sent.
Run 'nb telemetry off' to disable.  Learn more: https://nimblebrain.ai/telemetry
`.trim();

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
  enabled?: boolean;
  mode?: "tui" | "headless" | "serve" | "dev" | "subcommand";
  clientFactory?: TelemetryClientFactory;
}

/** Common properties enriched on every captured event. */
function commonProperties(): Record<string, unknown> {
  return {
    nb_version: "0.1.0",
    os: process.platform,
    arch: process.arch,
    bun_version: typeof Bun !== "undefined" ? Bun.version : "unknown",
  };
}

export class TelemetryManager {
  private client: TelemetryClient | null;
  private anonymousId: string;
  private enabled: boolean;

  private constructor(client: TelemetryClient | null, anonymousId: string, enabled: boolean) {
    this.client = client;
    this.anonymousId = anonymousId;
    this.enabled = enabled;
  }

  static create(options: TelemetryManagerOptions): TelemetryManager {
    // Env vars take priority (fastest check, no file I/O)
    if (process.env.NB_TELEMETRY_DISABLED === "1" || process.env.DO_NOT_TRACK === "1") {
      return new TelemetryManager(null, "disabled", false);
    }

    // Config check
    if (options.enabled === false) {
      return new TelemetryManager(null, "disabled", false);
    }

    // Ensure workDir exists
    mkdirSync(options.workDir, { recursive: true });

    // Load or create anonymous ID
    const idPath = join(options.workDir, TELEMETRY_ID_FILE);
    let isFirstRun = false;
    let anonymousId: string;

    if (existsSync(idPath)) {
      anonymousId = readFileSync(idPath, "utf-8").trim();
    } else {
      anonymousId = randomUUID();
      writeFileSync(idPath, `${anonymousId}\n`);
      isFirstRun = true;
    }

    if (isFirstRun) {
      process.stderr.write(`${FIRST_RUN_NOTICE}\n\n`);
    }

    // Initialize PostHog client — skip if no key is configured and no custom factory
    if (!POSTHOG_API_KEY && !options.clientFactory) {
      return new TelemetryManager(null, anonymousId, false);
    }
    const isServe = options.mode === "serve" || options.mode === "dev";
    const factory = options.clientFactory ?? defaultClientFactory;
    const client = factory(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      flushAt: isServe ? 20 : 1,
      flushInterval: isServe ? 30_000 : 0,
      disableGeoip: true,
    });

    return new TelemetryManager(client, anonymousId, true);
  }

  capture(event: string, properties: Record<string, unknown> = {}): void {
    if (!this.enabled || !this.client) return;
    this.client.capture({
      distinctId: this.anonymousId,
      event,
      properties: { ...commonProperties(), ...properties },
    });
  }

  async shutdown(): Promise<void> {
    if (!this.enabled || !this.client) return;
    await this.client.shutdown();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

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
  // Lazy import to avoid loading posthog-node when telemetry is disabled
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
