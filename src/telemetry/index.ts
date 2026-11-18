export type {
  TelemetryClient,
  TelemetryClientFactory,
  TelemetryConsent,
  TelemetryLock,
  TelemetryManagerOptions,
  TelemetryStatus,
} from "./manager.ts";
export { TelemetryLockedError, TelemetryManager } from "./manager.ts";
export { PostHogEventSink } from "./posthog-sink.ts";
