// ---------------------------------------------------------------------------
// Web-side feature flags
//
// The server-side `FeatureFlags` type in `src/config/features.ts` is the
// source of truth for platform features. A narrow subset of those flags
// controls browser-level behavior (e.g. whether the iframe bridge routes
// through `/mcp` or the legacy REST endpoints). Those flags live here so the
// web client can read them without a round-trip.
//
// The bootstrap handler is expected to forward relevant flags into this
// module via `setBridgeUseMcp()` at startup; until that wiring lands the
// flags stay at their server-side defaults (opt-in features default to
// false). Callers MUST read the getters at call time — never cache the
// result — so the flag can be toggled live without a page reload.
// ---------------------------------------------------------------------------

let bridgeUseMcp = false;

/**
 * Returns the current value of the `bridgeUseMcp` flag.
 *
 * Read this per call; do not cache at module load. The bridge's transport
 * selection depends on reading fresh values so feature-flag toggles take
 * effect without a reload.
 */
export function getBridgeUseMcp(): boolean {
  return bridgeUseMcp;
}

/**
 * Set the `bridgeUseMcp` flag.
 *
 * Called from the bootstrap wiring (or tests) when the resolved platform
 * features are known. Safe to call multiple times; the bridge reads the
 * flag per message dispatch.
 */
export function setBridgeUseMcp(value: boolean): void {
  bridgeUseMcp = value;
}
