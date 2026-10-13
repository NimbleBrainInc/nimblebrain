// biome-ignore-all lint/complexity/useLiteralKeys: the members are private; bracket access is TypeScript's typed path to them
import { type Mock, mock } from "bun:test";
import type { McpSource } from "../../src/tools/mcp-source.ts";

/**
 * The private state of an `McpSource` that tests drive directly: a fake client,
 * a seeded tool memo, a forced dead or stopped flag. Each property reads and
 * writes the source's own member, so every value is checked against the type
 * the source declares for it.
 */
export function mcpSourceInternals(source: McpSource) {
  return {
    get client() {
      return source["client"];
    },
    set client(value) {
      source["client"] = value;
    },
    get transport() {
      return source["transport"];
    },
    set transport(value) {
      source["transport"] = value;
    },
    get taskClient() {
      return source["taskClient"];
    },
    set taskClient(value) {
      source["taskClient"] = value;
    },
    get inProcessServer() {
      return source["inProcessServer"];
    },
    get protocolEra() {
      return source["protocolEra"];
    },
    set protocolEra(value) {
      source["protocolEra"] = value;
    },
    get cachedTools() {
      return source["cachedTools"];
    },
    set cachedTools(value) {
      source["cachedTools"] = value;
    },
    get toolsFetchedAt() {
      return source["toolsFetchedAt"];
    },
    set toolsFetchedAt(value) {
      source["toolsFetchedAt"] = value;
    },
    set toolsRefreshWaitMs(value: number) {
      source["toolsRefreshWaitMs"] = value;
    },
    set recoveryDelaysMs(value: readonly number[]) {
      source["recoveryDelaysMs"] = value;
    },
    set restartingSourceWait(value: McpSource["restartingSourceWait"]) {
      source["restartingSourceWait"] = value;
    },
    get dead() {
      return source["dead"];
    },
    set dead(value) {
      source["dead"] = value;
    },
    get stopped() {
      return source["stopped"];
    },
    set stopped(value) {
      source["stopped"] = value;
    },
    get downSince() {
      return source["downSince"];
    },
    set downSince(value) {
      source["downSince"] = value;
    },
    set lastReconnectFailedAt(value: number | null) {
      source["lastReconnectFailedAt"] = value;
    },
  };
}

/**
 * Replaces the source's private `tryRestart` with a mock that runs the real
 * restart until the test gives it another implementation. The mock is an own
 * property of this one source, so other sources keep the real method.
 */
export function mockTryRestart(source: McpSource): Mock<() => Promise<boolean>> {
  const real = source["tryRestart"].bind(source);
  const restart = mock(real);
  source["tryRestart"] = restart;
  return restart;
}
